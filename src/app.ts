import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";

import type { AppConfig } from "./config.js";
import { creatorLiveEventSchema, decodePubSubEvent, pubSubPushEnvelopeSchema } from "./domain/schemas.js";
import type { CampaignArtifact, CampaignRecord, CreatorLiveEvent, ProcessResult } from "./domain/types.js";
import { CampaignBusyError, type CreatorDutyOrchestrator } from "./orchestration/orchestrator.js";
import type { DispatchReceipt, EventDispatcher } from "./providers/events.js";
import type { StateStore } from "./storage/index.js";
import { StorageIntegrityError } from "./storage/index.js";
import { demoAuthorization, pubsubAuthorization } from "./web/auth.js";

const campaignIdPattern = /^[A-Za-z0-9_-]{3,128}$/;
const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface SystemDescriptor {
  service: "creator-duty";
  environment: AppConfig["nodeEnv"];
  storeProvider: AppConfig["storeProvider"];
  modelProvider: string;
  primaryModel: string;
  mediaProvider: string;
  publishProvider: string;
  eventTransport: "direct" | "pubsub";
  criticProvider: string | null;
  criticModel: string | null;
  additionalMediaModels: readonly string[];
}

export interface ArtifactByteRange {
  start: number;
  end: number;
}

export interface ArtifactResource {
  contentType: string;
  size: number;
  createReadStream(range?: ArtifactByteRange): Readable;
}

export interface ArtifactReader {
  open(artifact: CampaignArtifact): Promise<ArtifactResource>;
}

export class ArtifactProxyError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactProxyError";
  }
}

export interface DemoEventFactory {
  freshStart(): Promise<CreatorLiveEvent>;
  replayStart(latest: CampaignRecord | null): Promise<CreatorLiveEvent>;
  end(latest: CampaignRecord | null): Promise<CreatorLiveEvent>;
}

export class FixtureDemoEventFactory implements DemoEventFactory {
  private lastStart: CreatorLiveEvent | undefined;

  public constructor(
    private readonly fixtureDirectory: string,
    private readonly idFactory: () => string = randomUUID,
  ) {}

  public async freshStart(): Promise<CreatorLiveEvent> {
    const fixture = await this.load("live-started.json");
    const suffix = this.idFactory().replaceAll("-", "").slice(0, 40);
    const event = creatorLiveEventSchema.parse({
      ...fixture,
      eventId: `live_evt_demo_${suffix}`,
      stream: {
        ...fixture.stream,
        streamId: `live_stream_demo_${suffix}`,
      },
    });
    this.lastStart = event;
    return structuredClone(event);
  }

  public async replayStart(latest: CampaignRecord | null): Promise<CreatorLiveEvent> {
    if (this.lastStart !== undefined && (latest === null || this.lastStart.eventId === latest.eventId)) {
      return structuredClone(this.lastStart);
    }
    if (latest === null) {
      throw new DemoStateError("no_demo_campaign", "Start a campaign before replaying it.");
    }
    const fixture = await this.load("live-started.json");
    const event = creatorLiveEventSchema.parse({
      ...fixture,
      eventId: latest.eventId,
      stream: {
        ...fixture.stream,
        streamId: latest.streamId,
      },
    });
    this.lastStart = event;
    return structuredClone(event);
  }

  public async end(latest: CampaignRecord | null): Promise<CreatorLiveEvent> {
    const start = this.lastStart;
    if (latest === null && start === undefined) {
      throw new DemoStateError("no_demo_campaign", "Start a campaign before ending it.");
    }
    const fixture = await this.load("live-ended.json");
    const streamId = latest?.streamId ?? start!.stream.streamId;
    return creatorLiveEventSchema.parse({
      ...fixture,
      eventId: `live_end_${streamId}`.slice(0, 128),
      stream: {
        ...fixture.stream,
        streamId,
      },
    });
  }

  private async load(fileName: string): Promise<CreatorLiveEvent> {
    const value: unknown = JSON.parse(await readFile(path.join(this.fixtureDirectory, fileName), "utf8"));
    return creatorLiveEventSchema.parse(value);
  }
}

export class DemoStateError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DemoStateError";
  }
}

export interface CreatorDutyApplicationDependencies {
  config: AppConfig;
  store: StateStore;
  orchestrator: Pick<CreatorDutyOrchestrator, "process">;
  dispatcher: EventDispatcher;
  system: SystemDescriptor;
  artifactReader: ArtifactReader;
  demoEvents: DemoEventFactory;
  readiness(): Promise<void>;
  publicDirectory?: string;
}

export function createApp(dependencies: CreatorDutyApplicationDependencies): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json({ limit: "128kb", strict: true }));

  const health = (_request: Request, response: Response): void => {
    response.status(200).json({ status: "ok" });
  };
  app.get("/healthz", health);
  // Kept as a compatibility alias for existing deployment probes.
  app.get("/health", health);

  app.get("/readyz", async (_request, response) => {
    try {
      await dependencies.readiness();
      response.status(200).json({ status: "ready" });
    } catch {
      response.status(503).json({ error: "not_ready", retryable: true });
    }
  });

  app.get("/api/system", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json(dependencies.system);
  });

  app.post(
    "/events/pubsub",
    pubsubAuthorization(dependencies.config),
    async (request, response) => {
      try {
        const event = decodeStrictPubSubEvent(request.body);
        // Pub/Sub acknowledgement is intentionally withheld until the complete
        // workflow is durably checkpointed (or safely replayed).
        const result = await dependencies.orchestrator.process(event);
        response.status(200).json({ result });
      } catch (error) {
        if (error instanceof CampaignBusyError) {
          response.status(409).json({
            error: "campaign_busy",
            campaignId: error.campaignId,
            retryable: true,
          });
          return;
        }
        if (error instanceof ZodError || error instanceof SyntaxError || error instanceof StorageIntegrityError) {
          // Pub/Sub retries every non-success response. A conclusively malformed
          // or integrity-conflicting message is poison input, so acknowledge it
          // after classification instead of spending a day redelivering it.
          response.setHeader("X-Creator-Duty-Disposition", "invalid_event_ignored");
          response.status(204).end();
          return;
        }
        response.status(500).json({ error: "workflow_failed", retryable: true });
      }
    },
  );

  app.get("/api/campaigns", async (request, response) => {
    const limit = parseListLimit(request.query.limit);
    if (limit === null) {
      response.status(400).json({ error: "invalid_limit" });
      return;
    }
    const campaigns = await dependencies.store.listCampaigns(limit);
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ campaigns });
  });

  app.get("/api/campaigns/latest", async (_request, response) => {
    const campaign = await dependencies.store.getLatestCampaign();
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ campaign });
  });

  app.get("/api/campaigns/:campaignId", async (request, response) => {
    const campaignId = request.params.campaignId;
    if (campaignId === undefined || !campaignIdPattern.test(campaignId)) {
      response.status(400).json({ error: "invalid_campaign_id" });
      return;
    }
    const campaign = await dependencies.store.getCampaign(campaignId);
    if (campaign === null) {
      response.status(404).json({ error: "campaign_not_found" });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ campaign });
  });

  app.get("/api/campaigns/:campaignId/artifacts/:artifactId", async (request, response, next) => {
    try {
      const campaignId = request.params.campaignId;
      const artifactId = request.params.artifactId;
      if (
        campaignId === undefined ||
        artifactId === undefined ||
        !campaignIdPattern.test(campaignId) ||
        !campaignIdPattern.test(artifactId)
      ) {
        response.status(400).json({ error: "invalid_artifact_request" });
        return;
      }
      const campaign = await dependencies.store.getCampaign(campaignId);
      if (campaign === null) {
        response.status(404).json({ error: "campaign_not_found" });
        return;
      }
      const artifact = campaign.artifacts.find((candidate) => candidate.artifactId === artifactId);
      if (artifact === undefined) {
        response.status(404).json({ error: "artifact_not_found" });
        return;
      }
      const resource = await dependencies.artifactReader.open(artifact);
      const range = parseByteRange(request.headers.range, resource.size);
      if (range === "invalid") {
        response.setHeader("Content-Range", `bytes */${resource.size}`);
        response.status(416).end();
        return;
      }
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Content-Type", resource.contentType);
      response.setHeader("Cache-Control", "private, max-age=300");
      if (range === undefined) {
        response.setHeader("Content-Length", String(resource.size));
        resource.createReadStream().on("error", next).pipe(response);
        return;
      }
      response.status(206);
      response.setHeader("Content-Length", String(range.end - range.start + 1));
      response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${resource.size}`);
      resource.createReadStream(range).on("error", next).pipe(response);
    } catch (error) {
      next(error);
    }
  });

  const demoAuth = demoAuthorization(dependencies.config);
  app.post("/api/demo/start", demoAuth, async (_request, response) => {
    const quota = await dependencies.store.reserveDemoStart({
      dailyLimit: dependencies.config.demoDailyStartLimit,
      cooldownSeconds: dependencies.config.demoStartCooldownSeconds,
    });
    if (!quota.allowed) {
      response.setHeader("Retry-After", String(quota.retryAfterSeconds));
      response.status(429).json({
        error: "demo_start_quota_exceeded",
        retryAfterSeconds: quota.retryAfterSeconds,
        remaining: quota.remaining,
      });
      return;
    }
    const event = await dependencies.demoEvents.freshStart();
    response.status(202).json(await dependencies.dispatcher.dispatch(event));
  });

  app.post("/api/demo/replay", demoAuth, async (_request, response) => {
    const event = await dependencies.demoEvents.replayStart(await dependencies.store.getLatestCampaign());
    response.status(202).json(await dependencies.dispatcher.dispatch(event));
  });

  app.post("/api/demo/end", demoAuth, async (_request, response) => {
    const event = await dependencies.demoEvents.end(await dependencies.store.getLatestCampaign());
    response.status(202).json(await dependencies.dispatcher.dispatch(event));
  });

  const publicDirectory = dependencies.publicDirectory ?? path.join(process.cwd(), "public");
  app.use(express.static(publicDirectory, { index: "index.html", fallthrough: true }));

  app.use((_request, response) => {
    response.status(404).json({ error: "not_found" });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof ArtifactProxyError) {
      response.status(error.status).json({ error: error.code });
      return;
    }
    if (error instanceof DemoStateError) {
      response.status(409).json({ error: error.code });
      return;
    }
    if (error instanceof CampaignBusyError) {
      response.status(409).json({ error: "campaign_busy", retryable: true });
      return;
    }
    if (isJsonBodyError(error)) {
      response.status(400).json({ error: "invalid_json" });
      return;
    }
    response.status(500).json({ error: "internal_error" });
  });

  return app;
}

function decodeStrictPubSubEvent(input: unknown): CreatorLiveEvent {
  const envelope = pubSubPushEnvelopeSchema.parse(input);
  const encoded = envelope.message.data;
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !canonicalBase64Pattern.test(encoded) ||
    Buffer.from(encoded, "base64").toString("base64") !== encoded
  ) {
    throw new SyntaxError("Invalid base64 payload.");
  }
  try {
    return decodePubSubEvent(envelope);
  } catch (error) {
    if (error instanceof ZodError) throw error;
    throw new SyntaxError("Pub/Sub data is not a valid creator event.", { cause: error });
  }
}

function parseListLimit(value: unknown): number | null {
  if (value === undefined) {
    return 20;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]{0,2}$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return parsed <= 100 ? parsed : null;
}

function parseByteRange(value: string | undefined, size: number): ArtifactByteRange | "invalid" | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null || size <= 0) {
    return "invalid";
  }
  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (rawStart === "" && rawEnd === "") {
    return "invalid";
  }
  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return "invalid";
    }
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

function isJsonBodyError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 400
  );
}

export type { DispatchReceipt, ProcessResult };
