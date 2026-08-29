import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { GoogleGenAI } from "@google/genai";
import { GoogleAuth } from "google-auth-library";
import { describe, expect, it, vi } from "vitest";

import { sha256 } from "../src/domain/ids.js";
import type {
  CampaignArtifact,
  CampaignPlan,
  CampaignRecord,
  CreatorLiveEvent,
} from "../src/domain/types.js";
import {
  AdditionalMediaError,
  GoogleAdditionalMediaProvider,
  GoogleAuthLyriaInteractionsClient,
  GoogleGenAiVeoClient,
  LYRIA_MUSIC_VOLUME_CEILING,
  LyriaAdditionalMediaProvider,
  VeoAdditionalMediaProvider,
  mixLyriaUnderPromo,
  type AdditionalMediaInput,
  type AdditionalMediaProvider,
  type GeneratedMediaReader,
  type LyriaInteractionRequest,
  type LyriaInteractionsClient,
  type VeoClient,
  type VeoGenerateRequest,
  type VeoOperation,
} from "../src/providers/google-media.js";
import type { ArtifactObjectStore } from "../src/providers/media.js";

const execFile = promisify(execFileCallback);
const HAS_FFMPEG = commandExists("ffmpeg");
const HAS_FFPROBE = commandExists("ffprobe");
const FIXED_TIME = new Date("2026-08-29T12:00:00.000Z");

describe("Veo 3.1 additional media", () => {
  it("uses the configured model with portrait eight-second operation polling and immutable GCS persistence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "creator-duty-veo-"));
    try {
      const videoBytes = Buffer.from("mock-mp4-payload-with-stable-content");
      const operationName =
        "projects/demo-project/locations/global/publishers/google/models/veo-3.1-generate-preview/operations/op-123";
      const client = new FakeVeoClient(
        { name: operationName, done: false },
        {
          name: operationName,
          done: true,
          response: {
            generatedVideos: [
              {
                video: {
                  videoBytes: videoBytes.toString("base64"),
                  mimeType: "video/mp4",
                },
              },
            ],
          },
        },
      );
      const store = new CapturingObjectStore();
      const sleep = vi.fn(async (_milliseconds: number) => undefined);
      const provider = new VeoAdditionalMediaProvider({
        model: "veo-3.1-generate-preview",
        artifactDirectory: directory,
        objectStore: store,
        client,
        pollIntervalMs: 1,
        sleep,
        now: () => FIXED_TIME,
      });

      const [artifact] = await provider.generate(additionalMediaInput());
      expect(client.generateRequests).toHaveLength(1);
      expect(client.generateRequests[0]).toMatchObject({
        model: "veo-3.1-generate-preview",
        config: {
          numberOfVideos: 1,
          aspectRatio: "9:16",
          durationSeconds: 8,
          resolution: "1080p",
          generateAudio: false,
        },
      });
      expect(client.generateRequests[0]?.prompt).toContain("Agentic Launch Day");
      expect(client.polledOperations).toEqual([{ name: operationName, done: false }]);
      expect(sleep).toHaveBeenCalledWith(1);
      expect(artifact).toMatchObject({
        kind: "veo_broll",
        mimeType: "video/mp4",
        sha256: sha256(videoBytes),
        width: 1080,
        height: 1920,
        durationSeconds: 8,
        model: "veo-3.1-generate-preview",
        operationId: operationName,
        provider: "google_veo_3_1",
        createdAt: FIXED_TIME.toISOString(),
      });
      expect(artifact?.uri).toMatch(/^gs:\/\/immutable-test-bucket\//);
      expect(store.calls).toHaveLength(1);
      expect(store.calls[0]?.objectName).toContain(artifact?.sha256 ?? "missing");
      expect(store.calls[0]?.bytes).toEqual(videoBytes);
      expect(store.calls[0]?.sha256).toBe(sha256(videoBytes));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads a generated GCS URI before content-addressed final persistence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "creator-duty-veo-uri-"));
    try {
      const generatedUri = "gs://veo-staging/campaigns/op-456/video.mp4";
      const videoBytes = Buffer.from("downloaded-veo-video");
      const reader: GeneratedMediaReader = {
        read: vi.fn(async (uri: string) => {
          expect(uri).toBe(generatedUri);
          return videoBytes;
        }),
      };
      const operationName = "projects/demo-project/locations/global/operations/op-456";
      const client = new FakeVeoClient(
        {
          name: operationName,
          done: true,
          response: {
            generatedVideos: [{ video: { uri: generatedUri, mimeType: "video/mp4" } }],
          },
        },
      );
      const store = new CapturingObjectStore();
      const provider = new VeoAdditionalMediaProvider({
        model: "veo-3.1-generate-preview",
        artifactDirectory: directory,
        objectStore: store,
        client,
        generatedMediaReader: reader,
        outputGcsUri: "gs://veo-staging/campaigns/",
        now: () => FIXED_TIME,
      });

      const [artifact] = await provider.generate(additionalMediaInput());
      expect(client.generateRequests[0]?.config.outputGcsUri).toBe(
        "gs://veo-staging/campaigns/",
      );
      expect(reader.read).toHaveBeenCalledOnce();
      expect(artifact?.sha256).toBe(sha256(videoBytes));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a long-running operation never completes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "creator-duty-veo-timeout-"));
    try {
      const operation: VeoOperation = { name: "operations/stuck", done: false };
      const client = new FakeVeoClient(operation, operation);
      const provider = new VeoAdditionalMediaProvider({
        model: "veo-3.1-generate-preview",
        artifactDirectory: directory,
        objectStore: new CapturingObjectStore(),
        client,
        maxPollAttempts: 2,
        pollIntervalMs: 0,
        sleep: async () => undefined,
      });

      await expect(provider.generate(additionalMediaInput())).rejects.toMatchObject({
        code: "VEO_OPERATION_TIMEOUT",
      });
      expect(client.polledOperations).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("adapts the official @google/genai generateVideos and polling methods", async () => {
    const initial: VeoOperation = { name: "operations/sdk-op", done: false };
    const completed: VeoOperation = { name: "operations/sdk-op", done: true };
    const generateVideos = vi.fn(async () => initial);
    const getVideosOperation = vi.fn(async () => completed);
    const sdk = {
      models: { generateVideos },
      operations: { getVideosOperation },
    } as unknown as GoogleGenAI;
    const client = new GoogleGenAiVeoClient({ projectId: "demo-project", sdk });
    const request = veoRequest();

    expect(await client.generateVideos(request)).toBe(initial);
    expect(await client.getVideosOperation(initial)).toBe(completed);
    expect(generateVideos).toHaveBeenCalledWith(request);
    expect(getVideosOperation).toHaveBeenCalledWith({ operation: initial });
  });
});

describe("Lyria 3 Clip additional media", () => {
  it("calls the current global Vertex Interactions REST endpoint through google-auth-library", async () => {
    const responseData = { id: "interaction-rest-1", status: "completed" };
    const request = vi.fn(async () => ({ data: responseData }));
    const auth = new GoogleAuth();
    vi.spyOn(auth, "getClient").mockResolvedValue({ request } as never);
    const client = new GoogleAuthLyriaInteractionsClient({ auth });

    expect(
      await client.createInteraction({
        projectId: "demo-project",
        model: "lyria-3-clip-preview",
        prompt: "A restrained instrumental bed.",
      }),
    ).toEqual(responseData);
    expect(request).toHaveBeenCalledWith({
      url: "https://aiplatform.googleapis.com/v1beta1/projects/demo-project/locations/global/interactions",
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      data: {
        model: "lyria-3-clip-preview",
        input: [{ type: "text", text: "A restrained instrumental bed." }],
      },
    });
  });

  it("parses documented inline audio and records exact model/interaction evidence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "creator-duty-lyria-"));
    try {
      const audioBytes = Buffer.from("mock-mp3-audio-with-stable-content");
      const client = new FakeLyriaClient({
        id: "interaction-lyria-123",
        status: "completed",
        model: "lyria-3-clip-preview",
        outputs: [
          { type: "text", text: "instrumental" },
          {
            type: "audio",
            mime_type: "audio/mpeg",
            data: audioBytes.toString("base64"),
          },
        ],
      });
      const store = new CapturingObjectStore();
      const provider = new LyriaAdditionalMediaProvider({
        projectId: "demo-project",
        model: "lyria-3-clip-preview",
        artifactDirectory: directory,
        objectStore: store,
        client,
        now: () => FIXED_TIME,
      });

      const [artifact] = await provider.generate(additionalMediaInput());
      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]).toMatchObject({
        projectId: "demo-project",
        model: "lyria-3-clip-preview",
      });
      expect(client.requests[0]?.prompt).toContain("No vocals");
      expect(artifact).toMatchObject({
        kind: "lyria_music",
        mimeType: "audio/mpeg",
        sha256: sha256(audioBytes),
        durationSeconds: 30,
        model: "lyria-3-clip-preview",
        operationId: "interaction-lyria-123",
        provider: "google_lyria_3_clip",
        createdAt: FIXED_TIME.toISOString(),
      });
      expect(artifact?.uri).toMatch(/^gs:\/\/immutable-test-bucket\//);
      expect(store.calls[0]?.bytes).toEqual(audioBytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on missing or mismatched model/audio evidence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "creator-duty-lyria-invalid-"));
    try {
      const provider = new LyriaAdditionalMediaProvider({
        projectId: "demo-project",
        model: "lyria-3-clip-preview",
        artifactDirectory: directory,
        objectStore: new CapturingObjectStore(),
        client: new FakeLyriaClient({
          id: "interaction-wrong-model",
          status: "completed",
          model: "lyria-3-pro-preview",
          outputs: [],
        }),
      });

      await expect(provider.generate(additionalMediaInput())).rejects.toMatchObject({
        code: "LYRIA_OUTPUT_INVALID",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not hide a failure when composing optional Google providers", async () => {
    const generated = lyricArtifact();
    const first: AdditionalMediaProvider = {
      name: "first",
      generate: vi.fn(async () => [generated]),
    };
    const failure = new AdditionalMediaError(
      "second provider failed",
      "VEO_OPERATION_FAILED",
    );
    const second: AdditionalMediaProvider = {
      name: "second",
      generate: vi.fn(async () => {
        throw failure;
      }),
    };
    const provider = new GoogleAdditionalMediaProvider([first, second]);

    await expect(provider.generate(additionalMediaInput())).rejects.toBe(failure);
    expect(first.generate).toHaveBeenCalledOnce();
    expect(second.generate).toHaveBeenCalledOnce();
  });
});

describe("deterministic Lyria promo mix", () => {
  it.skipIf(!HAS_FFMPEG || !HAS_FFPROBE)(
    "trims the bed to 12 seconds and persists a new immutable promo with audio",
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "creator-duty-mix-"));
      try {
        const promoPath = path.join(directory, "base-promo.mp4");
        const musicPath = path.join(directory, "music.wav");
        await execFile("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:s=108x192:r=10:d=12",
          "-c:v",
          "mpeg4",
          "-q:v",
          "5",
          "-an",
          promoPath,
        ]);
        await execFile("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=44100:duration=20",
          "-c:a",
          "pcm_s16le",
          musicPath,
        ]);
        const promo = promoArtifact();
        const music = lyricArtifact();
        const store = new CapturingObjectStore();

        const mixed = await mixLyriaUnderPromo({
          campaignId: "campaign-google-media",
          promo,
          music,
          promoPath,
          musicPath,
          artifactDirectory: directory,
          objectStore: store,
          now: () => FIXED_TIME,
        });

        expect(mixed).toMatchObject({
          kind: "promo_video",
          durationSeconds: 12,
          model: music.model,
          operationId: music.operationId,
          provider: "ffmpeg_lyria_mix",
        });
        expect(mixed.artifactId).not.toBe(promo.artifactId);
        expect(mixed.sha256).toBe(store.calls[0]?.sha256);
        const outputPath = store.calls[0]?.localPath;
        expect(outputPath).toBeDefined();
        const { stdout } = await execFile("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type:format=duration",
          "-of",
          "json",
          outputPath!,
        ]);
        const probe = JSON.parse(stdout) as {
          streams?: Array<{ codec_type?: string }>;
          format?: { duration?: string };
        };
        expect(probe.streams?.some((stream) => stream.codec_type === "video")).toBe(true);
        expect(probe.streams?.some((stream) => stream.codec_type === "audio")).toBe(true);
        expect(Number(probe.format?.duration)).toBeCloseTo(12, 1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("rejects a music gain above the safety ceiling", async () => {
    await expect(
      mixLyriaUnderPromo({
        campaignId: "campaign-google-media",
        promo: promoArtifact(),
        music: lyricArtifact(),
        promoPath: "/not-used.mp4",
        musicPath: "/not-used.mp3",
        artifactDirectory: os.tmpdir(),
        objectStore: new CapturingObjectStore(),
        musicVolume: LYRIA_MUSIC_VOLUME_CEILING + 0.01,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });
});

class FakeVeoClient implements VeoClient {
  public readonly generateRequests: VeoGenerateRequest[] = [];
  public readonly polledOperations: VeoOperation[] = [];

  public constructor(
    private readonly initial: VeoOperation,
    private readonly completed: VeoOperation = initial,
  ) {}

  public async generateVideos(request: VeoGenerateRequest): Promise<VeoOperation> {
    this.generateRequests.push(request);
    return this.initial;
  }

  public async getVideosOperation(operation: VeoOperation): Promise<VeoOperation> {
    this.polledOperations.push(operation);
    return this.completed;
  }
}

class FakeLyriaClient implements LyriaInteractionsClient {
  public readonly requests: LyriaInteractionRequest[] = [];

  public constructor(private readonly response: unknown) {}

  public async createInteraction(request: LyriaInteractionRequest): Promise<unknown> {
    this.requests.push(request);
    return this.response;
  }
}

class CapturingObjectStore implements ArtifactObjectStore {
  public readonly calls: Array<{
    localPath: string;
    objectName: string;
    contentType: string;
    sha256: string;
    bytes: Buffer;
  }> = [];

  public async persist(input: {
    localPath: string;
    objectName: string;
    contentType: string;
    sha256: string;
  }): Promise<string> {
    const bytes = await readFile(input.localPath);
    if (sha256(bytes) !== input.sha256) throw new Error("test store received a hash mismatch");
    this.calls.push({ ...input, bytes });
    return `gs://immutable-test-bucket/${input.objectName}`;
  }
}

function additionalMediaInput(): AdditionalMediaInput {
  const plan: CampaignPlan = {
    angle: "Show that autonomous follow-through compounds creator momentum.",
    hook: "The stream ended; the campaign already started.",
    tone: "bold",
    selectedMoment: {
      startSeconds: 12,
      endSeconds: 24,
      rationale: "Concise product reveal.",
    },
    channels: ["x", "linkedin"],
    estimatedModelSpendUsd: 1.25,
  };
  const event: CreatorLiveEvent = {
    eventId: "event-google-media",
    eventType: "creator.live.started",
    occurredAt: "2026-08-29T10:00:00.000Z",
    creatorId: "creator-sigmora",
    stream: {
      streamId: "stream-google-media",
      title: "Agentic Launch Day",
      url: "https://example.test/live",
      sourceClipId: "clip-google-media",
      transcriptId: "transcript-google-media",
    },
    preauthorizationProfileId: "preauth-google-media",
  };
  const campaign: CampaignRecord = {
    campaignId: "campaign-google-media",
    eventId: event.eventId,
    creatorId: event.creatorId,
    streamId: event.stream.streamId,
    traceId: "trace-google-media",
    runId: "run-google-media",
    stage: "producing",
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
    modelProvider: "vertex_ai",
    primaryModel: "gemini-3.7-flash",
    plan,
    variants: [],
    artifacts: [promoArtifact()],
    receipts: [],
    steps: [],
    invocations: [],
    metrics: {
      humanActions: 0,
      manualHandoffsReplaced: 0,
      channelCount: 0,
      retryCount: 0,
      duplicatePosts: 0,
    },
  };
  return { campaign, event, plan, promo: promoArtifact() };
}

function promoArtifact(): CampaignArtifact {
  return {
    artifactId: "art_promo_base",
    kind: "promo_video",
    uri: "/artifacts/base-promo.mp4",
    mimeType: "video/mp4",
    sha256: "a".repeat(64),
    width: 108,
    height: 192,
    durationSeconds: 12,
    createdAt: FIXED_TIME.toISOString(),
    provider: "deterministic_renderer",
  };
}

function lyricArtifact(): CampaignArtifact {
  return {
    artifactId: "art_lyria_base",
    kind: "lyria_music",
    uri: "gs://immutable-test-bucket/music.mp3",
    mimeType: "audio/mpeg",
    sha256: "b".repeat(64),
    durationSeconds: 30,
    model: "lyria-3-clip-preview",
    operationId: "interaction-lyria-mix",
    prompt: "Instrumental music bed.",
    createdAt: FIXED_TIME.toISOString(),
    provider: "google_lyria_3_clip",
  };
}

function veoRequest(): VeoGenerateRequest {
  return {
    model: "veo-3.1-generate-preview",
    prompt: "Portrait b-roll.",
    config: {
      numberOfVideos: 1,
      aspectRatio: "9:16",
      durationSeconds: 8,
      resolution: "1080p",
      generateAudio: false,
    },
  };
}

function commandExists(command: string): boolean {
  return spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0;
}
