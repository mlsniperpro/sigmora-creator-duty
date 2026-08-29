import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { sha256 } from "../src/domain/ids.js";
import type {
  CampaignArtifact,
  CampaignPlan,
  CampaignRecord,
  Channel,
  ChannelVariant,
  CreatorLiveEvent,
  LiveSource,
  ProviderPublication,
} from "../src/domain/types.js";
import { DeterministicMediaRenderer, SigmoraMediaRenderer } from "../src/providers/media.js";
import {
  DeterministicSandboxPublisher,
  SigmoraPublisher,
  type PublicationStore,
  type PublishRequest,
} from "../src/providers/publisher.js";
import { MemoryStateStore } from "../src/storage/memory-state-store.js";

const execFile = promisify(execFileCallback);
const HAS_FFMPEG = commandExists("ffmpeg");
const HAS_FFPROBE = commandExists("ffprobe");

describe("deterministic media renderer", () => {
  it.skipIf(!HAS_FFMPEG)(
    "renders immutable 1080x1920 poster and real 12-second MP4",
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "creator-duty-media-"));
      try {
        const renderer = new DeterministicMediaRenderer({ artifactDirectory: directory });
        const artifacts = await renderer.renderPromo(renderInput());
        expect(artifacts.map(({ kind }) => kind).sort()).toEqual(["poster", "promo_video"]);

        const poster = requiredArtifact(artifacts, "poster");
        const video = requiredArtifact(artifacts, "promo_video");
        const posterPath = localArtifactPath(directory, poster);
        const videoPath = localArtifactPath(directory, video);

        expect(sha256(await readFile(posterPath))).toBe(poster.sha256);
        expect(sha256(await readFile(videoPath))).toBe(video.sha256);
        expect(poster.artifactId).toContain("art_poster_");
        expect(video.artifactId).toContain("art_promo_");
        expect(video).toMatchObject({
          width: 1080,
          height: 1920,
          durationSeconds: 12,
          mimeType: "video/mp4",
        });

        const posterMetadata = await sharp(posterPath).metadata();
        expect(posterMetadata.width).toBe(1080);
        expect(posterMetadata.height).toBe(1920);

        if (HAS_FFPROBE) {
          const { stdout } = await execFile(
            "ffprobe",
            [
              "-v",
              "error",
              "-show_entries",
              "stream=width,height:format=duration",
              "-of",
              "json",
              videoPath,
            ],
            { maxBuffer: 1024 * 1024 },
          );
          const probe = JSON.parse(stdout) as {
            streams?: Array<{ width?: number; height?: number }>;
            format?: { duration?: string };
          };
          expect(probe.streams?.[0]).toMatchObject({ width: 1080, height: 1920 });
          expect(Number(probe.format?.duration)).toBeCloseTo(12, 1);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("keeps the Sigmora media boundary narrow and idempotent", async () => {
    const input = renderInput();
    const responseArtifacts = [
      artifact("poster", "poster-sha"),
      artifact("promo_video", "video-sha"),
    ];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer scoped-media-token");
      expect(headers.get("idempotency-key")).toMatch(/^render_/);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ campaignId: input.campaign.campaignId });
      return Response.json({ artifacts: responseArtifacts });
    });
    const renderer = new SigmoraMediaRenderer({
      baseUrl: "https://sigmora.example/",
      token: "scoped-media-token",
      fetch: fetchMock,
    });
    const rendered = await renderer.renderPromo(input);
    expect(rendered).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("deterministic sandbox publisher", () => {
  it("fails once before commit, then retries only that logical target", async () => {
    const store = new CountingPublicationStore();
    const publisher = new DeterministicSandboxPublisher(store, {
      failBeforeCommitOnce: "linkedin",
    });
    const request = publishRequest("linkedin", "publish-linkedin-001");

    await expect(publisher.publish(request)).rejects.toMatchObject({
      code: "SANDBOX_TRANSIENT_BEFORE_COMMIT",
      retryable: true,
      ambiguous: false,
    });
    expect(await publisher.lookup(request.idempotencyKey)).toBeUndefined();

    const committed = await publisher.publish(request);
    expect(await publisher.verify(committed)).toBe(true);
    expect(await publisher.publish(request)).toEqual(committed);
    expect(store.recordCalls).toBe(1);
  });

  it("reconciles an ambiguous after-commit failure by lookup without duplicating", async () => {
    const store = new CountingPublicationStore();
    const publisher = new DeterministicSandboxPublisher(store, {
      failAfterCommitOnce: "instagram",
    });
    const request = publishRequest("instagram", "publish-instagram-001");

    await expect(publisher.publish(request)).rejects.toMatchObject({
      code: "SANDBOX_AMBIGUOUS_AFTER_COMMIT",
      retryable: true,
      ambiguous: true,
    });
    const observed = await publisher.lookup(request.idempotencyKey);
    expect(observed).toBeDefined();
    expect(await publisher.verify(observed!)).toBe(true);

    const replay = await publisher.publish(request);
    expect(replay).toEqual(observed);
    expect(store.recordCalls).toBe(1);
  });

  it("rejects conflicting reuse of an idempotency key", async () => {
    const store = new CountingPublicationStore();
    const publisher = new DeterministicSandboxPublisher(store);
    const original = publishRequest("x", "same-key");
    const committed = await publisher.publish(original);
    const conflict: PublishRequest = {
      ...original,
      variant: { ...original.variant, copy: "Different semantic content for the same key." },
    };

    await expect(publisher.publish(conflict)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      retryable: false,
      ambiguous: false,
    });
    expect(await publisher.lookup(original.idempotencyKey)).toEqual(committed);
    expect(store.recordCalls).toBe(1);
  });
});

describe("Sigmora publisher", () => {
  it("sends the idempotency header and verifies through remote lookup", async () => {
    const request = publishRequest("youtube_shorts", "sigmora-key-001");
    const publication: ProviderPublication = {
      idempotencyKey: request.idempotencyKey,
      channel: request.channel,
      providerPostId: "sigmora-post-001",
      providerUrl: "https://sigmora.example/sandbox/posts/sigmora-post-001",
      committedAt: "2026-08-30T12:00:05.000Z",
    };
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "POST") {
        const headers = new Headers(init.headers);
        expect(headers.get("idempotency-key")).toBe(request.idempotencyKey);
        expect(headers.get("authorization")).toBe("Bearer scoped-publish-token");
        return Response.json({ publication });
      }
      expect(String(url)).toContain(encodeURIComponent(request.idempotencyKey));
      return Response.json(publication);
    });
    const publisher = new SigmoraPublisher({
      baseUrl: "https://sigmora.example/",
      token: "scoped-publish-token",
      fetch: fetchMock,
    });

    expect(await publisher.publish(request)).toEqual(publication);
    expect(await publisher.verify(publication)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

class CountingPublicationStore implements PublicationStore {
  private readonly inner = new MemoryStateStore();
  public recordCalls = 0;

  public getProviderPublication(idempotencyKey: string): Promise<ProviderPublication | null> {
    return this.inner.getProviderPublication(idempotencyKey);
  }

  public recordProviderPublication(publication: ProviderPublication): Promise<ProviderPublication> {
    this.recordCalls += 1;
    return this.inner.recordProviderPublication(publication);
  }
}

function renderInput(): {
  campaign: CampaignRecord;
  event: CreatorLiveEvent;
  plan: CampaignPlan;
  source: LiveSource;
} {
  const now = "2026-08-30T12:00:00.000Z";
  const event: CreatorLiveEvent = {
    eventId: "live_evt_provider_001",
    eventType: "creator.live.started",
    occurredAt: now,
    creatorId: "demo_creator",
    stream: {
      streamId: "stream_provider_001",
      title: "Building Creator Duty Live",
      url: "https://demo.invalid/live/creator-duty",
      sourceClipId: "clip_provider_001",
      transcriptId: "transcript_provider_001",
    },
    preauthorizationProfileId: "taskmaster_demo_v1",
  };
  const plan: CampaignPlan = {
    angle: "Creators stay present while the campaign operates itself.",
    hook: "Stay live. Creator Duty handles the campaign.",
    tone: "calm",
    selectedMoment: {
      startSeconds: 38,
      endSeconds: 50,
      rationale: "This moment demonstrates bounded, reliable autonomy.",
    },
    channels: ["x", "linkedin", "instagram", "youtube_shorts"],
    estimatedModelSpendUsd: 0.05,
  };
  const campaign: CampaignRecord = {
    campaignId: "cmp_provider_001",
    eventId: event.eventId,
    creatorId: event.creatorId,
    streamId: event.stream.streamId,
    traceId: "trace_provider_001",
    runId: "run_provider_001",
    stage: "producing",
    createdAt: now,
    updatedAt: now,
    modelProvider: "deterministic",
    primaryModel: "deterministic-v1",
    plan,
    variants: [],
    artifacts: [],
    receipts: [],
    steps: [],
    invocations: [],
    metrics: {
      humanActions: 0,
      manualHandoffsReplaced: 7,
      channelCount: 0,
      retryCount: 0,
      duplicatePosts: 0,
    },
  };
  const source: LiveSource = {
    sourceClipId: event.stream.sourceClipId,
    transcriptId: event.stream.transcriptId,
    durationSeconds: 96,
    transcript: [
      {
        startSeconds: 38,
        endSeconds: 58,
        text: "Safe action means deterministic policy, idempotency, receipts, and targeted recovery.",
      },
    ],
    audienceQuestions: ["How do you stop duplicate posts?"],
  };
  return { campaign, event, plan, source };
}

function publishRequest(channel: Channel, idempotencyKey: string): PublishRequest {
  const variant: ChannelVariant = {
    channel,
    copy: `Platform-native ${channel} launch copy for Creator Duty.`,
    ctaUrl: "https://sigmora.org/creator-duty",
    hashtags: ["#AllThingsAgenticHackathon"],
  };
  return {
    campaignId: "cmp_provider_001",
    channel,
    variant,
    artifact: artifact("promo_video", "publisher-artifact"),
    releaseHash: sha256("release-provider-001"),
    idempotencyKey,
  };
}

function artifact(
  kind: "poster" | "promo_video",
  seed: string,
): CampaignArtifact {
  return {
    artifactId: `artifact_${seed}`,
    kind,
    uri: `/artifacts/${seed}.${kind === "poster" ? "png" : "mp4"}`,
    mimeType: kind === "poster" ? "image/png" : "video/mp4",
    sha256: sha256(seed),
    width: 1080,
    height: 1920,
    ...(kind === "promo_video" ? { durationSeconds: 12 } : {}),
    createdAt: "2026-08-30T12:00:01.000Z",
    provider: "test",
  };
}

function requiredArtifact(
  artifacts: CampaignArtifact[],
  kind: CampaignArtifact["kind"],
): CampaignArtifact {
  const found = artifacts.find((candidate) => candidate.kind === kind);
  if (!found) throw new Error(`Missing ${kind} artifact.`);
  return found;
}

function localArtifactPath(directory: string, artifactValue: CampaignArtifact): string {
  const fileName = artifactValue.uri.split("/").at(-1);
  if (!fileName) throw new Error(`Artifact has no local filename: ${artifactValue.uri}`);
  return path.join(directory, decodeURIComponent(fileName));
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["-version"], { stdio: "ignore" });
  return result.status === 0;
}
