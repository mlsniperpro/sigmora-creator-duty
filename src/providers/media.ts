import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { Storage } from "@google-cloud/storage";
import sharp from "sharp";
import { z } from "zod";

import { sha256, stableId } from "../domain/ids.js";
import type {
  CampaignArtifact,
  CampaignPlan,
  CampaignRecord,
  CreatorLiveEvent,
  LiveSource,
} from "../domain/types.js";

const execFileAsync = promisify(execFile);

const POSTER_WIDTH = 1080;
const POSTER_HEIGHT = 1920;
const PROMO_DURATION_SECONDS = 12;
const PROMO_FRAME_RATE = 30;

export interface RenderPromoInput {
  campaign: CampaignRecord;
  event: CreatorLiveEvent;
  plan: CampaignPlan;
  source: LiveSource;
}

export interface MediaRenderer {
  readonly name: string;
  renderPromo(input: RenderPromoInput): Promise<CampaignArtifact[]>;
}

/**
 * Optional immutable object persistence for rendered artifacts. Implementations
 * return a URI that the application can serve through its authenticated proxy.
 */
export interface ArtifactObjectStore {
  /** True when durable persistence makes the local file disposable. */
  readonly cleanupLocalFileAfterPersist?: boolean;
  persist(input: {
    localPath: string;
    objectName: string;
    contentType: string;
    sha256: string;
  }): Promise<string>;
}

export interface GcsArtifactStoreOptions {
  projectId?: string;
  storage?: Storage;
}

/** Persist immutable, content-addressed outputs in Google Cloud Storage. */
export class GcsArtifactStore implements ArtifactObjectStore {
  public readonly cleanupLocalFileAfterPersist = true;
  private readonly storage: Storage;

  public constructor(
    private readonly bucketName: string,
    options: GcsArtifactStoreOptions = {},
  ) {
    if (!bucketName.trim()) throw new Error("A non-empty GCS artifact bucket is required.");
    this.storage = options.storage ?? new Storage(
      options.projectId === undefined ? {} : { projectId: options.projectId },
    );
  }

  public async persist(input: {
    localPath: string;
    objectName: string;
    contentType: string;
    sha256: string;
  }): Promise<string> {
    const file = this.storage.bucket(this.bucketName).file(input.objectName);
    const bytes = await readFile(input.localPath);
    try {
      await file.save(bytes, {
        resumable: false,
        validation: "crc32c",
        metadata: {
          contentType: input.contentType,
          cacheControl: "private, max-age=31536000, immutable",
          metadata: { sha256: input.sha256 },
        },
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      const [metadata] = await file.getMetadata();
      if (metadata.metadata?.sha256 !== input.sha256) {
        throw new Error(`Immutable GCS object conflict for ${input.objectName}.`, { cause: error });
      }
    }
    return `gs://${this.bucketName}/${input.objectName}`;
  }
}

export interface DeterministicMediaRendererOptions {
  artifactDirectory: string;
  /** URL path mounted by the judging server for local artifacts. */
  artifactUrlPrefix?: string;
  objectStore?: ArtifactObjectStore;
  ffmpegExecutable?: string;
}

/**
 * Reproducible media provider used by the public simulator. It renders a real
 * PNG and a real 12-second H.264/MPEG-4 MP4, then content-addresses both files.
 */
export class DeterministicMediaRenderer implements MediaRenderer {
  public readonly name = "deterministic_renderer";

  private readonly artifactUrlPrefix: string;
  private readonly ffmpegExecutable: string;

  public constructor(private readonly options: DeterministicMediaRendererOptions) {
    if (!options.artifactDirectory.trim()) {
      throw new Error("A non-empty artifact directory is required.");
    }
    this.artifactUrlPrefix = normalizeUrlPrefix(options.artifactUrlPrefix ?? "/artifacts");
    this.ffmpegExecutable = options.ffmpegExecutable ?? "ffmpeg";
  }

  public async renderPromo(input: RenderPromoInput): Promise<CampaignArtifact[]> {
    await mkdir(this.options.artifactDirectory, { recursive: true });
    const stagingDirectory = await mkdtemp(path.join(this.options.artifactDirectory, ".render-"));
    const stagedPoster = path.join(stagingDirectory, "poster.png");
    const stagedVideo = path.join(stagingDirectory, "promo.mp4");

    try {
      await sharp(Buffer.from(posterSvg(input), "utf8"))
        .png({ compressionLevel: 9, adaptiveFiltering: false })
        .toFile(stagedPoster);
      await renderStillVideo({
        executable: this.ffmpegExecutable,
        posterPath: stagedPoster,
        outputPath: stagedVideo,
      });

      const poster = await this.finalizeArtifact({
        campaignId: input.campaign.campaignId,
        kind: "poster",
        stagedPath: stagedPoster,
        extension: "png",
        mimeType: "image/png",
      });
      const video = await this.finalizeArtifact({
        campaignId: input.campaign.campaignId,
        kind: "promo_video",
        stagedPath: stagedVideo,
        extension: "mp4",
        mimeType: "video/mp4",
      });
      return [poster, video];
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  private async finalizeArtifact(input: {
    campaignId: string;
    kind: "poster" | "promo_video";
    stagedPath: string;
    extension: "png" | "mp4";
    mimeType: "image/png" | "video/mp4";
  }): Promise<CampaignArtifact> {
    const bytes = await readFile(input.stagedPath);
    const digest = sha256(bytes);
    const safeCampaignId = safePathSegment(input.campaignId);
    const fileName = `${safeCampaignId}-${input.kind}-${digest.slice(0, 16)}.${input.extension}`;
    const finalPath = path.join(this.options.artifactDirectory, fileName);
    await copyImmutable(input.stagedPath, finalPath, digest);

    const objectName = `creator-duty/${safeCampaignId}/${fileName}`;
    let uri: string;
    if (this.options.objectStore) {
      try {
        uri = await this.options.objectStore.persist({
          localPath: finalPath,
          objectName,
          contentType: input.mimeType,
          sha256: digest,
        });
      } finally {
        // Cloud Run's writable filesystem consumes instance memory. Once the
        // immutable object store has accepted (or rejected) the upload, the
        // local content-addressed copy must not accumulate across campaigns.
        if (this.options.objectStore.cleanupLocalFileAfterPersist === true) {
          await rm(finalPath, { force: true });
        }
      }
    } else {
      uri = `${this.artifactUrlPrefix}/${encodeURIComponent(fileName)}`;
    }

    return {
      artifactId: stableId(input.kind === "poster" ? "art_poster" : "art_promo", `${input.campaignId}:${digest}`, 32),
      kind: input.kind,
      uri,
      mimeType: input.mimeType,
      sha256: digest,
      width: POSTER_WIDTH,
      height: POSTER_HEIGHT,
      ...(input.kind === "promo_video" ? { durationSeconds: PROMO_DURATION_SECONDS } : {}),
      createdAt: new Date().toISOString(),
      provider: this.name,
    };
  }
}

const campaignArtifactSchema = z
  .object({
    artifactId: z.string().min(1),
    kind: z.enum(["poster", "promo_video", "veo_broll", "lyria_music"]),
    uri: z.string().min(1),
    mimeType: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationSeconds: z.number().positive().optional(),
    model: z.string().min(1).optional(),
    operationId: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    createdAt: z.iso.datetime({ offset: true }),
    provider: z.string().min(1),
  })
  .strict();

const sigmoraMediaResponseSchema = z
  .object({ artifacts: z.array(campaignArtifactSchema).min(1).max(4) })
  .strict();

export interface SigmoraMediaRendererOptions {
  baseUrl: string;
  token: string;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Scoped HTTP boundary to the disclosed, pre-existing Sigmora renderer. */
export class SigmoraMediaRenderer implements MediaRenderer {
  public readonly name = "sigmora_scoped_renderer";

  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;

  public constructor(private readonly options: SigmoraMediaRendererOptions) {
    if (!options.token.trim()) throw new Error("A Sigmora media token is required.");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.endpoint = resolveEndpoint(options.baseUrl, options.endpoint ?? "v1/creator-duty/media/render-promo");
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  public async renderPromo(input: RenderPromoInput): Promise<CampaignArtifact[]> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": stableId("render", input.campaign.campaignId, 32),
      },
      body: JSON.stringify({
        campaignId: input.campaign.campaignId,
        creatorId: input.event.creatorId,
        stream: {
          title: input.event.stream.title,
          sourceClipId: input.event.stream.sourceClipId,
          transcriptId: input.event.stream.transcriptId,
        },
        selectedMoment: input.plan.selectedMoment,
        hook: input.plan.hook,
        angle: input.plan.angle,
        output: {
          width: POSTER_WIDTH,
          height: POSTER_HEIGHT,
          durationSeconds: PROMO_DURATION_SECONDS,
          formats: ["image/png", "video/mp4"],
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Sigmora media render failed with HTTP ${response.status}.`);
    }
    const parsed = sigmoraMediaResponseSchema.parse(await response.json());
    const poster = parsed.artifacts.find((artifact) => artifact.kind === "poster");
    const promo = parsed.artifacts.find((artifact) => artifact.kind === "promo_video");
    if (!poster || !promo) {
      throw new Error("Sigmora media response must contain one poster and one promo video.");
    }
    if (
      promo.width !== POSTER_WIDTH ||
      promo.height !== POSTER_HEIGHT ||
      promo.durationSeconds !== PROMO_DURATION_SECONDS
    ) {
      throw new Error("Sigmora promo does not satisfy the immutable 1080x1920, 12-second contract.");
    }
    return parsed.artifacts.map(normalizeCampaignArtifact);
  }
}

async function renderStillVideo(input: {
  executable: string;
  posterPath: string;
  outputPath: string;
}): Promise<void> {
  const common = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-loop",
    "1",
    "-framerate",
    String(PROMO_FRAME_RATE),
    "-i",
    input.posterPath,
    "-t",
    String(PROMO_DURATION_SECONDS),
    "-vf",
    `scale=${POSTER_WIDTH}:${POSTER_HEIGHT}:flags=lanczos,format=yuv420p`,
    "-r",
    String(PROMO_FRAME_RATE),
    "-frames:v",
    String(PROMO_DURATION_SECONDS * PROMO_FRAME_RATE),
    "-an",
    "-map_metadata",
    "-1",
    "-movflags",
    "+faststart",
  ];

  try {
    await execFileAsync(input.executable, [
      ...common,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "stillimage",
      input.outputPath,
    ], { maxBuffer: 2 * 1024 * 1024 });
  } catch (firstError) {
    try {
      await execFileAsync(input.executable, [
        ...common,
        "-c:v",
        "mpeg4",
        "-q:v",
        "3",
        input.outputPath,
      ], { maxBuffer: 2 * 1024 * 1024 });
    } catch (fallbackError) {
      throw new Error("ffmpeg could not render the deterministic promo MP4.", {
        cause: new AggregateError([firstError, fallbackError]),
      });
    }
  }
}

function posterSvg(input: RenderPromoInput): string {
  const titleLines = wrapText(input.event.stream.title, 24, 3);
  const hookLines = wrapText(input.plan.hook, 34, 4);
  const title = svgTextLines(titleLines, 200, 430, 100, 104, "title");
  const hook = svgTextLines(hookLines, 135, 950, 76, 86, "hook");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#111827"/>
      <stop offset="0.55" stop-color="#24134f"/>
      <stop offset="1" stop-color="#090b12"/>
    </linearGradient>
    <radialGradient id="glow" cx="75%" cy="15%" r="70%">
      <stop offset="0" stop-color="#a78bfa" stop-opacity="0.52"/>
      <stop offset="1" stop-color="#7c3aed" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <rect width="1080" height="1920" fill="url(#glow)"/>
  <rect x="90" y="112" width="900" height="60" rx="30" fill="#8b5cf6" fill-opacity="0.18" stroke="#c4b5fd" stroke-opacity="0.65"/>
  <text x="540" y="153" text-anchor="middle" fill="#ede9fe" font-size="28" font-family="Arial, Helvetica, sans-serif" font-weight="700" letter-spacing="5">CREATOR DUTY BY SIGMORA</text>
  ${title}
  <line x1="135" x2="945" y1="825" y2="825" stroke="#a78bfa" stroke-width="5"/>
  ${hook}
  <g transform="translate(135 1450)">
    <circle cx="26" cy="26" r="26" fill="#22c55e"/>
    <path d="M14 27l8 8 17-19" fill="none" stroke="#07110a" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="78" y="38" fill="#d1fae5" font-size="42" font-family="Arial, Helvetica, sans-serif" font-weight="700">Autonomous campaign in progress</text>
  </g>
  <rect x="135" y="1600" width="810" height="135" rx="28" fill="#ffffff" fill-opacity="0.08" stroke="#ffffff" stroke-opacity="0.16"/>
  <text x="540" y="1660" text-anchor="middle" fill="#ddd6fe" font-size="32" font-family="Arial, Helvetica, sans-serif">Stay live.</text>
  <text x="540" y="1712" text-anchor="middle" fill="#ffffff" font-size="45" font-family="Arial, Helvetica, sans-serif" font-weight="800">Creator Duty handles the campaign.</text>
</svg>`;
}

function svgTextLines(
  lines: string[],
  x: number,
  y: number,
  fontSize: number,
  lineHeight: number,
  className: "title" | "hook",
): string {
  const fill = className === "title" ? "#ffffff" : "#ddd6fe";
  const weight = className === "title" ? "800" : "600";
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${fontSize}" font-family="Arial, Helvetica, sans-serif" font-weight="${weight}">${lines
    .map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
    .join("")}</text>`;
}

function wrapText(value: string, maximumCharacters: number, maximumLines: number): string[] {
  const words = value.trim().split(/\s+/);
  const lines: string[] = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || current.length + word.length + 1 > maximumCharacters) {
      if (lines.length === maximumLines) {
        const last = lines[maximumLines - 1] ?? "";
        lines[maximumLines - 1] = `${last.replace(/[.\u2026]+$/, "")}…`;
        break;
      }
      lines.push(word);
    } else {
      lines[lines.length - 1] = `${current} ${word}`;
    }
  }
  return lines;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function copyImmutable(sourcePath: string, targetPath: string, expectedHash: string): Promise<void> {
  try {
    await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existingHash = sha256(await readFile(targetPath));
    if (existingHash !== expectedHash) {
      throw new Error(`Immutable artifact conflict at ${targetPath}.`, { cause: error });
    }
  }
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid campaign artifact path.");
  return safe;
}

function normalizeUrlPrefix(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed.startsWith("/")) throw new Error("Artifact URL prefix must be an absolute URL path.");
  return trimmed || "/artifacts";
}

function resolveEndpoint(baseUrl: string, endpoint: string): URL {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
    throw new Error("Sigmora media base URL must use HTTPS outside local development.");
  }
  const normalizedBase = `${base.toString().replace(/\/+$/, "")}/`;
  return new URL(endpoint.replace(/^\/+/, ""), normalizedBase);
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isPreconditionFailure(error: unknown): boolean {
  return error instanceof Error && "code" in error && Number(error.code) === 412;
}

function normalizeCampaignArtifact(
  artifact: z.infer<typeof campaignArtifactSchema>,
): CampaignArtifact {
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    uri: artifact.uri,
    mimeType: artifact.mimeType,
    sha256: artifact.sha256,
    createdAt: artifact.createdAt,
    provider: artifact.provider,
    ...(artifact.width === undefined ? {} : { width: artifact.width }),
    ...(artifact.height === undefined ? {} : { height: artifact.height }),
    ...(artifact.durationSeconds === undefined
      ? {}
      : { durationSeconds: artifact.durationSeconds }),
    ...(artifact.model === undefined ? {} : { model: artifact.model }),
    ...(artifact.operationId === undefined ? {} : { operationId: artifact.operationId }),
    ...(artifact.prompt === undefined ? {} : { prompt: artifact.prompt }),
  };
}

// Compatibility names for callers that use provider terminology.
export { DeterministicMediaRenderer as DeterministicMediaProvider };
export { SigmoraMediaRenderer as SigmoraMediaProvider };
