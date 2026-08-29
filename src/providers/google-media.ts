import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Storage } from "@google-cloud/storage";
import {
  GoogleGenAI,
  type GenerateVideosOperation,
} from "@google/genai";
import { GoogleAuth } from "google-auth-library";

import { sha256, stableId } from "../domain/ids.js";
import type {
  CampaignArtifact,
  CampaignPlan,
  CampaignRecord,
  CreatorLiveEvent,
} from "../domain/types.js";
import type { ArtifactObjectStore } from "./media.js";

const execFileAsync = promisify(execFile);

const VEO_WIDTH = 1080;
const VEO_HEIGHT = 1920;
const VEO_DURATION_SECONDS = 8;
const LYRIA_DURATION_SECONDS = 30;
const PROMO_DURATION_SECONDS = 12;

/** A conservative music-bed gain which leaves headroom for speech and effects. */
export const LYRIA_MUSIC_VOLUME_CEILING = 0.16;

export interface AdditionalMediaInput {
  campaign: CampaignRecord;
  event: CreatorLiveEvent;
  plan: CampaignPlan;
  promo: CampaignArtifact;
}

/** Optional media generators run after the deterministic promo has been rendered. */
export interface AdditionalMediaProvider {
  readonly name: string;
  generate(input: AdditionalMediaInput): Promise<CampaignArtifact[]>;
}

export type AdditionalMediaErrorCode =
  | "INVALID_CONFIGURATION"
  | "VEO_OPERATION_FAILED"
  | "VEO_OPERATION_TIMEOUT"
  | "VEO_OUTPUT_INVALID"
  | "LYRIA_INTERACTION_FAILED"
  | "LYRIA_OUTPUT_INVALID"
  | "GENERATED_MEDIA_UNREADABLE"
  | "ARTIFACT_PERSISTENCE_FAILED"
  | "MEDIA_MIX_FAILED";

/** Fail-closed error surfaced to the orchestrator for retry/checkpoint handling. */
export class AdditionalMediaError extends Error {
  public override readonly name = "AdditionalMediaError";

  public constructor(
    message: string,
    public readonly code: AdditionalMediaErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface VeoGenerateRequest {
  model: string;
  prompt: string;
  config: {
    numberOfVideos: 1;
    aspectRatio: "9:16";
    durationSeconds: 8;
    resolution: "1080p";
    generateAudio: false;
    outputGcsUri?: string;
  };
}

export interface VeoVideoOutput {
  uri?: string;
  videoBytes?: string;
  mimeType?: string;
}

export interface VeoOperation {
  name?: string;
  done?: boolean;
  error?: unknown;
  response?: {
    generatedVideos?: Array<{ video?: VeoVideoOutput }>;
  };
}

/** Narrow seam around the official @google/genai long-running video API. */
export interface VeoClient {
  generateVideos(request: VeoGenerateRequest): Promise<VeoOperation>;
  getVideosOperation(operation: VeoOperation): Promise<VeoOperation>;
}

export interface GoogleGenAiVeoClientOptions {
  projectId: string;
  location?: string;
  sdk?: GoogleGenAI;
}

/** Production Veo client. Tests can inject either this SDK or the narrower VeoClient. */
export class GoogleGenAiVeoClient implements VeoClient {
  private readonly sdk: GoogleGenAI;

  public constructor(options: GoogleGenAiVeoClientOptions) {
    requireNonEmpty(options.projectId, "Google Cloud project ID");
    this.sdk =
      options.sdk ??
      new GoogleGenAI({
        vertexai: true,
        project: options.projectId,
        location: options.location ?? "global",
      });
  }

  public async generateVideos(request: VeoGenerateRequest): Promise<VeoOperation> {
    return this.sdk.models.generateVideos(request);
  }

  public async getVideosOperation(operation: VeoOperation): Promise<VeoOperation> {
    return this.sdk.operations.getVideosOperation({
      operation: operation as GenerateVideosOperation,
    });
  }
}

/** Reads generated media returned by Google as an immutable Cloud Storage URI. */
export interface GeneratedMediaReader {
  read(uri: string): Promise<Buffer>;
}

export interface GcsGeneratedMediaReaderOptions {
  projectId?: string;
  storage?: Storage;
}

export class GcsGeneratedMediaReader implements GeneratedMediaReader {
  private readonly storage: Storage;

  public constructor(options: GcsGeneratedMediaReaderOptions = {}) {
    this.storage =
      options.storage ??
      new Storage(options.projectId === undefined ? {} : { projectId: options.projectId });
  }

  public async read(uri: string): Promise<Buffer> {
    const parsed = parseGcsUri(uri);
    const [bytes] = await this.storage.bucket(parsed.bucket).file(parsed.objectName).download();
    if (bytes.length === 0) {
      throw new AdditionalMediaError(
        `Generated Cloud Storage object is empty: ${uri}.`,
        "GENERATED_MEDIA_UNREADABLE",
      );
    }
    return bytes;
  }
}

export interface VeoAdditionalMediaProviderOptions {
  model: string;
  artifactDirectory: string;
  objectStore: ArtifactObjectStore;
  projectId?: string;
  location?: string;
  outputGcsUri?: string;
  client?: VeoClient;
  generatedMediaReader?: GeneratedMediaReader;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

/** Generates one portrait, eight-second Veo 3.1 b-roll artifact. */
export class VeoAdditionalMediaProvider implements AdditionalMediaProvider {
  public readonly name = "google_veo_3_1";

  private readonly client: VeoClient;
  private readonly generatedMediaReader: GeneratedMediaReader;
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;

  public constructor(private readonly options: VeoAdditionalMediaProviderOptions) {
    requireExactIdentifier(options.model, "Veo model ID");
    requireNonEmpty(options.artifactDirectory, "artifact directory");
    if (options.outputGcsUri !== undefined) parseGcsPrefix(options.outputGcsUri);
    if (options.pollIntervalMs !== undefined && options.pollIntervalMs < 0) {
      throw configurationError("Veo poll interval must not be negative.");
    }
    if (
      options.maxPollAttempts !== undefined &&
      (!Number.isInteger(options.maxPollAttempts) || options.maxPollAttempts < 1)
    ) {
      throw configurationError("Veo max poll attempts must be a positive integer.");
    }

    if (options.client) {
      this.client = options.client;
    } else {
      const projectId = requireNonEmpty(options.projectId, "Google Cloud project ID");
      this.client = new GoogleGenAiVeoClient({
        projectId,
        ...(options.location === undefined ? {} : { location: options.location }),
      });
    }
    this.generatedMediaReader =
      options.generatedMediaReader ??
      new GcsGeneratedMediaReader(
        options.projectId === undefined ? {} : { projectId: options.projectId },
      );
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.maxPollAttempts = options.maxPollAttempts ?? 80;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => new Date());
  }

  public async generate(input: AdditionalMediaInput): Promise<CampaignArtifact[]> {
    const prompt = createVeoPrompt(input);
    try {
      const request: VeoGenerateRequest = {
        model: this.options.model,
        prompt,
        config: {
          numberOfVideos: 1,
          aspectRatio: "9:16",
          durationSeconds: VEO_DURATION_SECONDS,
          resolution: "1080p",
          generateAudio: false,
          ...(this.options.outputGcsUri === undefined
            ? {}
            : { outputGcsUri: this.options.outputGcsUri }),
        },
      };
      let operation = await this.client.generateVideos(request);
      const operationId = requireOperationId(operation.name, "Veo");

      let pollAttempts = 0;
      while (!operation.done && pollAttempts < this.maxPollAttempts) {
        await this.sleep(this.pollIntervalMs);
        operation = await this.client.getVideosOperation(operation);
        pollAttempts += 1;
        if (operation.name !== undefined && operation.name !== operationId) {
          throw new AdditionalMediaError(
            `Veo operation identity changed from ${operationId} to ${operation.name}.`,
            "VEO_OUTPUT_INVALID",
          );
        }
      }
      if (!operation.done) {
        throw new AdditionalMediaError(
          `Veo operation ${operationId} did not complete after ${this.maxPollAttempts} polls.`,
          "VEO_OPERATION_TIMEOUT",
        );
      }
      if (operation.error !== undefined) {
        throw new AdditionalMediaError(
          `Veo operation ${operationId} failed: ${safeJson(operation.error)}.`,
          "VEO_OPERATION_FAILED",
        );
      }

      const video = operation.response?.generatedVideos?.[0]?.video;
      if (!video) {
        throw new AdditionalMediaError(
          `Veo operation ${operationId} completed without a generated video.`,
          "VEO_OUTPUT_INVALID",
        );
      }
      const mimeType = normalizeVideoMimeType(video.mimeType);
      const bytes = await readGeneratedBytes(video, this.generatedMediaReader);
      const artifact = await persistArtifact({
        artifactDirectory: this.options.artifactDirectory,
        objectStore: this.options.objectStore,
        campaignId: input.campaign.campaignId,
        kind: "veo_broll",
        idPrefix: "art_veo",
        bytes,
        extension: "mp4",
        mimeType,
        provider: this.name,
        model: this.options.model,
        operationId,
        prompt,
        width: VEO_WIDTH,
        height: VEO_HEIGHT,
        durationSeconds: VEO_DURATION_SECONDS,
        now: this.now,
      });
      return [artifact];
    } catch (error) {
      if (error instanceof AdditionalMediaError) throw error;
      throw new AdditionalMediaError("Veo generation failed closed.", "VEO_OPERATION_FAILED", {
        cause: error,
      });
    }
  }
}

export interface LyriaInteractionRequest {
  projectId: string;
  model: string;
  prompt: string;
}

/** Test seam around the Vertex Interactions REST endpoint. */
export interface LyriaInteractionsClient {
  createInteraction(request: LyriaInteractionRequest): Promise<unknown>;
}

export interface GoogleAuthLyriaInteractionsClientOptions {
  auth?: GoogleAuth;
}

/** Current Lyria 3 REST client authenticated with Application Default Credentials. */
export class GoogleAuthLyriaInteractionsClient implements LyriaInteractionsClient {
  private readonly auth: GoogleAuth;

  public constructor(options: GoogleAuthLyriaInteractionsClientOptions = {}) {
    this.auth =
      options.auth ??
      new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  }

  public async createInteraction(request: LyriaInteractionRequest): Promise<unknown> {
    requireExactIdentifier(request.model, "Lyria model ID");
    const projectId = requireProjectId(request.projectId);
    const client = await this.auth.getClient();
    const response = await client.request<unknown>({
      url: `https://aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/global/interactions`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      data: {
        model: request.model,
        input: [{ type: "text", text: request.prompt }],
      },
    });
    return response.data;
  }
}

export interface LyriaAdditionalMediaProviderOptions {
  projectId: string;
  model: string;
  artifactDirectory: string;
  objectStore: ArtifactObjectStore;
  client?: LyriaInteractionsClient;
  generatedMediaReader?: GeneratedMediaReader;
  now?: () => Date;
}

/** Generates one Lyria 3 Clip music artifact through Vertex Interactions REST. */
export class LyriaAdditionalMediaProvider implements AdditionalMediaProvider {
  public readonly name = "google_lyria_3_clip";

  private readonly client: LyriaInteractionsClient;
  private readonly generatedMediaReader: GeneratedMediaReader;
  private readonly now: () => Date;

  public constructor(private readonly options: LyriaAdditionalMediaProviderOptions) {
    requireProjectId(options.projectId);
    requireExactIdentifier(options.model, "Lyria model ID");
    requireNonEmpty(options.artifactDirectory, "artifact directory");
    this.client = options.client ?? new GoogleAuthLyriaInteractionsClient();
    this.generatedMediaReader =
      options.generatedMediaReader ?? new GcsGeneratedMediaReader({ projectId: options.projectId });
    this.now = options.now ?? (() => new Date());
  }

  public async generate(input: AdditionalMediaInput): Promise<CampaignArtifact[]> {
    const prompt = createLyriaPrompt(input);
    try {
      const raw = await this.client.createInteraction({
        projectId: this.options.projectId,
        model: this.options.model,
        prompt,
      });
      const response = requireRecord(raw, "Lyria interaction response");
      if (response.status !== "completed") {
        throw new AdditionalMediaError(
          `Lyria interaction did not complete successfully (status=${String(response.status)}).`,
          "LYRIA_INTERACTION_FAILED",
        );
      }
      if (response.model !== this.options.model) {
        throw new AdditionalMediaError(
          `Lyria response model evidence does not match requested model ${this.options.model}.`,
          "LYRIA_OUTPUT_INVALID",
        );
      }
      const operationId = requireOperationId(
        firstString(response.id, response.name, response.operationId),
        "Lyria interaction",
      );
      const audio = findAudioBlock(response);
      if (!audio) {
        throw new AdditionalMediaError(
          `Lyria interaction ${operationId} completed without inline or URI audio.`,
          "LYRIA_OUTPUT_INVALID",
        );
      }
      const mimeType = normalizeAudioMimeType(firstString(audio.mime_type, audio.mimeType));
      const bytes =
        typeof audio.data === "string"
          ? decodeBase64(audio.data, "Lyria audio")
          : typeof audio.uri === "string"
            ? await this.generatedMediaReader.read(audio.uri)
            : undefined;
      if (!bytes || bytes.length === 0) {
        throw new AdditionalMediaError(
          `Lyria interaction ${operationId} returned unreadable audio.`,
          "LYRIA_OUTPUT_INVALID",
        );
      }

      const artifact = await persistArtifact({
        artifactDirectory: this.options.artifactDirectory,
        objectStore: this.options.objectStore,
        campaignId: input.campaign.campaignId,
        kind: "lyria_music",
        idPrefix: "art_lyria",
        bytes,
        extension: "mp3",
        mimeType,
        provider: this.name,
        model: this.options.model,
        operationId,
        prompt,
        durationSeconds: LYRIA_DURATION_SECONDS,
        now: this.now,
      });
      return [artifact];
    } catch (error) {
      if (error instanceof AdditionalMediaError) throw error;
      throw new AdditionalMediaError(
        "Lyria interaction failed closed.",
        "LYRIA_INTERACTION_FAILED",
        { cause: error },
      );
    }
  }
}

/** Runs enabled Google generators in order; any failure rejects the whole step. */
export class GoogleAdditionalMediaProvider implements AdditionalMediaProvider {
  public readonly name = "google_additional_media";

  public constructor(private readonly providers: readonly AdditionalMediaProvider[]) {}

  public async generate(input: AdditionalMediaInput): Promise<CampaignArtifact[]> {
    const artifacts: CampaignArtifact[] = [];
    for (const provider of this.providers) {
      artifacts.push(...(await provider.generate(input)));
    }
    return artifacts;
  }
}

export interface MixLyriaUnderPromoInput {
  campaignId: string;
  promo: CampaignArtifact;
  music: CampaignArtifact;
  promoPath: string;
  musicPath: string;
  artifactDirectory: string;
  objectStore: ArtifactObjectStore;
  promoHasAudio?: boolean;
  musicVolume?: number;
  ffmpegExecutable?: string;
  now?: () => Date;
}

/**
 * Adds a capped Lyria bed beneath a promo, trimming the music/output to exactly
 * twelve seconds. The original promo remains immutable; a new hash-addressed
 * promo artifact is returned.
 */
export async function mixLyriaUnderPromo(
  input: MixLyriaUnderPromoInput,
): Promise<CampaignArtifact> {
  if (input.promo.kind !== "promo_video") {
    throw configurationError("The base artifact for a Lyria mix must be a promo video.");
  }
  if (input.music.kind !== "lyria_music") {
    throw configurationError("The music artifact for a Lyria mix must be Lyria music.");
  }
  requireNonEmpty(input.artifactDirectory, "artifact directory");
  const volume = input.musicVolume ?? LYRIA_MUSIC_VOLUME_CEILING;
  if (!Number.isFinite(volume) || volume <= 0 || volume > LYRIA_MUSIC_VOLUME_CEILING) {
    throw configurationError(
      `Music volume must be greater than zero and at most ${LYRIA_MUSIC_VOLUME_CEILING}.`,
    );
  }

  await mkdir(input.artifactDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(path.join(input.artifactDirectory, ".mix-"));
  const stagedOutput = path.join(stagingDirectory, "promo-with-lyria.mp4");
  const bed = `[1:a:0]atrim=start=0:end=${PROMO_DURATION_SECONDS},asetpts=PTS-STARTPTS,volume=${volume.toFixed(3)}[bed]`;
  const filter = input.promoHasAudio
    ? `[0:a:0]atrim=start=0:end=${PROMO_DURATION_SECONDS},asetpts=PTS-STARTPTS[base];${bed};[base][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.90[aout]`
    : `${bed};[bed]alimiter=limit=0.90[aout]`;

  try {
    await execFileAsync(
      input.ffmpegExecutable ?? "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        input.promoPath,
        "-stream_loop",
        "-1",
        "-i",
        input.musicPath,
        "-filter_complex",
        filter,
        "-map",
        "0:v:0",
        "-map",
        "[aout]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-t",
        String(PROMO_DURATION_SECONDS),
        "-shortest",
        "-map_metadata",
        "-1",
        "-metadata",
        "creation_time=1970-01-01T00:00:00Z",
        "-movflags",
        "+faststart",
        stagedOutput,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const bytes = await readFile(stagedOutput);
    return await persistArtifact({
      artifactDirectory: input.artifactDirectory,
      objectStore: input.objectStore,
      campaignId: input.campaignId,
      kind: "promo_video",
      idPrefix: "art_promo_mix",
      bytes,
      extension: "mp4",
      mimeType: "video/mp4",
      provider: "ffmpeg_lyria_mix",
      ...(input.music.model === undefined ? {} : { model: input.music.model }),
      ...(input.music.operationId === undefined
        ? {}
        : { operationId: input.music.operationId }),
      ...(input.music.prompt === undefined ? {} : { prompt: input.music.prompt }),
      ...(input.promo.width === undefined ? {} : { width: input.promo.width }),
      ...(input.promo.height === undefined ? {} : { height: input.promo.height }),
      durationSeconds: PROMO_DURATION_SECONDS,
      now: input.now ?? (() => new Date()),
    });
  } catch (error) {
    if (error instanceof AdditionalMediaError) throw error;
    throw new AdditionalMediaError(
      "ffmpeg could not mix the Lyria bed beneath the promo.",
      "MEDIA_MIX_FAILED",
      { cause: error },
    );
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

interface PersistArtifactInput {
  artifactDirectory: string;
  objectStore: ArtifactObjectStore;
  campaignId: string;
  kind: CampaignArtifact["kind"];
  idPrefix: string;
  bytes: Buffer;
  extension: "mp3" | "mp4";
  mimeType: string;
  provider: string;
  model?: string;
  operationId?: string;
  prompt?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  now: () => Date;
}

async function persistArtifact(input: PersistArtifactInput): Promise<CampaignArtifact> {
  if (input.bytes.length === 0) {
    throw new AdditionalMediaError("Generated artifact bytes are empty.", "ARTIFACT_PERSISTENCE_FAILED");
  }
  try {
    await mkdir(input.artifactDirectory, { recursive: true });
    const digest = sha256(input.bytes);
    const campaignSegment = safePathSegment(input.campaignId);
    const fileName = `${campaignSegment}-${input.kind}-${digest}.${input.extension}`;
    const finalPath = path.join(input.artifactDirectory, fileName);
    await writeImmutableBytes(input.bytes, finalPath, digest);
    const objectName = `creator-duty/${campaignSegment}/google-media/${fileName}`;
    let uri: string;
    try {
      uri = await input.objectStore.persist({
        localPath: finalPath,
        objectName,
        contentType: input.mimeType,
        sha256: digest,
      });
    } finally {
      // Generated media is durable in object storage; retaining local finals
      // would consume Cloud Run instance memory for the life of the container.
      if (input.objectStore.cleanupLocalFileAfterPersist === true) {
        await rm(finalPath, { force: true });
      }
    }
    requireNonEmpty(uri, "persisted artifact URI");

    return {
      artifactId: stableId(input.idPrefix, `${input.campaignId}:${digest}`, 32),
      kind: input.kind,
      uri,
      mimeType: input.mimeType,
      sha256: digest,
      createdAt: input.now().toISOString(),
      provider: input.provider,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.width === undefined ? {} : { width: input.width }),
      ...(input.height === undefined ? {} : { height: input.height }),
      ...(input.durationSeconds === undefined
        ? {}
        : { durationSeconds: input.durationSeconds }),
    };
  } catch (error) {
    if (error instanceof AdditionalMediaError) throw error;
    throw new AdditionalMediaError(
      "Generated artifact could not be persisted immutably.",
      "ARTIFACT_PERSISTENCE_FAILED",
      { cause: error },
    );
  }
}

async function writeImmutableBytes(
  bytes: Buffer,
  targetPath: string,
  expectedHash: string,
): Promise<void> {
  const stagingDirectory = await mkdtemp(path.join(path.dirname(targetPath), ".persist-"));
  const stagedPath = path.join(stagingDirectory, "artifact");
  try {
    await writeFile(stagedPath, bytes);
    try {
      await copyFile(stagedPath, targetPath, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (sha256(await readFile(targetPath)) !== expectedHash) {
        throw new AdditionalMediaError(
          `Immutable artifact conflict at ${targetPath}.`,
          "ARTIFACT_PERSISTENCE_FAILED",
          { cause: error },
        );
      }
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function readGeneratedBytes(
  video: VeoVideoOutput,
  reader: GeneratedMediaReader,
): Promise<Buffer> {
  if (typeof video.videoBytes === "string") {
    return decodeBase64(video.videoBytes, "Veo video");
  }
  if (typeof video.uri === "string") return reader.read(video.uri);
  throw new AdditionalMediaError(
    "Veo video has neither inline bytes nor a Cloud Storage URI.",
    "VEO_OUTPUT_INVALID",
  );
}

function findAudioBlock(root: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = root.output_audio;
  if (isAudioBlock(direct)) return direct;

  for (const key of ["outputs", "steps", "content", "output"] as const) {
    const candidate = findAudioInValue(root[key], 0);
    if (candidate) return candidate;
  }
  return undefined;
}

function findAudioInValue(value: unknown, depth: number): Record<string, unknown> | undefined {
  if (depth > 4) return undefined;
  if (isAudioBlock(value)) return value;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findAudioInValue(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ["outputs", "steps", "content", "output", "output_audio"] as const) {
    const found = findAudioInValue(value[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function isAudioBlock(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.type === "audio" &&
    (typeof value.data === "string" || typeof value.uri === "string")
  );
}

function decodeBase64(value: string, label: string): Buffer {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new AdditionalMediaError(`${label} is not valid base64.`, "GENERATED_MEDIA_UNREADABLE");
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0) {
    throw new AdditionalMediaError(`${label} decoded to zero bytes.`, "GENERATED_MEDIA_UNREADABLE");
  }
  return bytes;
}

function normalizeVideoMimeType(value: string | undefined): "video/mp4" {
  if (value !== undefined && value !== "video/mp4") {
    throw new AdditionalMediaError(
      `Unsupported Veo output MIME type: ${value}.`,
      "VEO_OUTPUT_INVALID",
    );
  }
  return "video/mp4";
}

function normalizeAudioMimeType(value: string | undefined): "audio/mpeg" | "audio/mp3" {
  if (value === "audio/mpeg" || value === "audio/mp3") return value;
  throw new AdditionalMediaError(
    `Unsupported or missing Lyria output MIME type: ${String(value)}.`,
    "LYRIA_OUTPUT_INVALID",
  );
}

function createVeoPrompt(input: AdditionalMediaInput): string {
  return [
    `Create an eight-second cinematic vertical b-roll clip for the creator livestream "${input.event.stream.title}".`,
    `Campaign angle: ${input.plan.angle}.`,
    `Tone: ${input.plan.tone}.`,
    `Visual hook: ${input.plan.hook}.`,
    "Use dynamic but calm camera motion, safe central framing, no logos, and no readable text.",
  ].join(" ");
}

function createLyriaPrompt(input: AdditionalMediaInput): string {
  return [
    `Create a polished instrumental music bed for a vertical creator promo about "${input.event.stream.title}".`,
    `Campaign angle: ${input.plan.angle}.`,
    `Tone: ${input.plan.tone}.`,
    "No vocals, no spoken words, no abrupt intro, and leave generous headroom for narration.",
  ].join(" ");
}

function parseGcsPrefix(uri: string): void {
  const parsed = parseGcsUri(uri.replace(/\/+$/, "") + "/placeholder");
  requireNonEmpty(parsed.bucket, "Veo output GCS bucket");
}

function parseGcsUri(uri: string): { bucket: string; objectName: string } {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match?.[1] || !match[2] || match[2].includes("..")) {
    throw new AdditionalMediaError(
      `Expected an object-level gs:// URI, received ${uri}.`,
      "GENERATED_MEDIA_UNREADABLE",
    );
  }
  return { bucket: match[1], objectName: match[2] };
}

function requireOperationId(value: string | undefined, provider: string): string {
  if (!value?.trim()) {
    throw new AdditionalMediaError(
      `${provider} response is missing operation/interaction identity evidence.`,
      provider.startsWith("Veo") ? "VEO_OUTPUT_INVALID" : "LYRIA_OUTPUT_INVALID",
    );
  }
  return value;
}

function requireProjectId(value: string): string {
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(value)) {
    throw configurationError("A valid Google Cloud project ID is required.");
  }
  return value;
}

function requireExactIdentifier(value: string, label: string): void {
  if (!value || value !== value.trim() || /\s/.test(value)) {
    throw configurationError(`${label} must be a non-empty exact model identifier.`);
  }
}

function requireNonEmpty(value: string | undefined, label: string): string {
  if (!value?.trim()) throw configurationError(`A non-empty ${label} is required.`);
  return value;
}

function configurationError(message: string): AdditionalMediaError {
  return new AdditionalMediaError(message, "INVALID_CONFIGURATION");
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  if (!safe || safe === "." || safe === "..") throw configurationError("Invalid campaign ID.");
  return safe;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AdditionalMediaError(`${label} is not an object.`, "LYRIA_OUTPUT_INVALID");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 1_000);
  } catch {
    return String(value).slice(0, 1_000);
  }
}
