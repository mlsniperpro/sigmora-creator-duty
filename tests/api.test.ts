import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import type { Storage } from "@google-cloud/storage";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FixtureDemoEventFactory,
  createApp,
  type ArtifactReader,
  type CreatorDutyApplicationDependencies,
} from "../src/app.js";
import { RuntimeArtifactReader } from "../src/bootstrap.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { creatorLiveEventSchema } from "../src/domain/schemas.js";
import type {
  CampaignArtifact,
  CampaignRecord,
  CreatorLiveEvent,
  ProcessResult,
} from "../src/domain/types.js";
import { CampaignBusyError } from "../src/orchestration/orchestrator.js";
import { DirectEventDispatcher } from "../src/providers/events.js";
import { MemoryStateStore } from "../src/storage/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Creator Duty HTTP API", () => {
  it("reports liveness, readiness, and only safe exact provider/model metadata", async () => {
    const dependencies = dependenciesFor({
      config: testConfig({
        GEMINI_API_KEY: "never-leak-gemini",
        SIGMORA_API_TOKEN: "never-leak-sigmora",
        GOOGLE_CLOUD_PROJECT: "private-project",
        ARTIFACT_BUCKET: "private-bucket",
      }),
    });
    const app = createApp(dependencies);

    await request(app).get("/healthz").expect(200, { status: "ok" });
    await request(app).get("/readyz").expect(200, { status: "ready" });
    const response = await request(app).get("/api/system").expect(200);

    expect(response.body).toEqual(dependencies.system);
    expect(response.body).toMatchObject({
      modelProvider: "deterministic",
      primaryModel: "deterministic-campaign-v1",
      eventTransport: "direct",
    });
    const encoded = JSON.stringify(response.body);
    expect(encoded).not.toContain("never-leak");
    expect(encoded).not.toContain("private-project");
    expect(encoded).not.toContain("private-bucket");
  });

  it("fails readiness closed without leaking the dependency error", async () => {
    const dependencies = dependenciesFor({
      readiness: async () => {
        throw new Error("secret database details");
      },
    });
    const response = await request(createApp(dependencies)).get("/readyz").expect(503);
    expect(response.body).toEqual({ error: "not_ready", retryable: true });
    expect(response.text).not.toContain("secret database details");
  });

  it("strictly decodes and acknowledges poison Pub/Sub input without invoking the workflow", async () => {
    const process = vi.fn(async (event: CreatorLiveEvent) => resultFor(event));
    const app = createApp(dependenciesFor({ process }));

    const malformedBase64 = await request(app)
      .post("/events/pubsub")
      .send({ message: { data: "not base64" } })
      .expect(204);
    expect(malformedBase64.headers["x-creator-duty-disposition"]).toBe("invalid_event_ignored");
    await request(app)
      .post("/events/pubsub")
      .send({ message: { data: Buffer.from("not json").toString("base64") } })
      .expect(204);
    await request(app)
      .post("/events/pubsub")
      .send({ message: { data: Buffer.from(JSON.stringify(await fixtureEvent())).toString("base64") }, extra: true })
      .expect(204);
    expect(process).not.toHaveBeenCalled();
  });

  it("awaits the complete workflow before acknowledging Pub/Sub", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const event = await fixtureEvent();
    const process = vi.fn(async (received: CreatorLiveEvent) => {
      await gate;
      return resultFor(received);
    });
    const pending = request(createApp(dependenciesFor({ process })))
      .post("/events/pubsub")
      .send(pubsubEnvelope(event));
    let settled = false;
    const responsePromise = pending.then((response) => {
      settled = true;
      return response;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({ eventId: event.eventId, stage: "complete" });
    expect(process).toHaveBeenCalledOnce();
  });

  it("accepts Google's documented wrapped push metadata", async () => {
    const event = await fixtureEvent();
    const process = vi.fn(async (received: CreatorLiveEvent) => resultFor(received));
    const publishedAt = "2026-08-29T19:29:27.123Z";

    const response = await request(createApp(dependenciesFor({ process })))
      .post("/events/pubsub")
      .send({
        deliveryAttempt: 1,
        message: {
          attributes: { source: "cloud-e2e" },
          data: Buffer.from(JSON.stringify(event), "utf8").toString("base64"),
          messageId: "21357600256905202",
          message_id: "21357600256905202",
          orderingKey: "creator-stream-001",
          publishTime: publishedAt,
          publish_time: publishedAt,
        },
        subscription: "projects/creator-duty/subscriptions/creator-duty-push",
      })
      .expect(200);

    expect(response.body.result).toMatchObject({ eventId: event.eventId, stage: "complete" });
    expect(process).toHaveBeenCalledOnce();
  });

  it("acknowledges conflicting Pub/Sub metadata aliases as poison input", async () => {
    const event = await fixtureEvent();
    const process = vi.fn(async (received: CreatorLiveEvent) => resultFor(received));

    const response = await request(createApp(dependenciesFor({ process })))
      .post("/events/pubsub")
      .send({
        message: {
          data: Buffer.from(JSON.stringify(event), "utf8").toString("base64"),
          messageId: "message-a",
          message_id: "message-b",
        },
      })
      .expect(204);

    expect(response.headers["x-creator-duty-disposition"]).toBe("invalid_event_ignored");
    expect(process).not.toHaveBeenCalled();
  });

  it("returns a non-2xx retryable response for an active execution lease", async () => {
    const event = await fixtureEvent();
    const app = createApp(dependenciesFor({
      process: async () => {
        throw new CampaignBusyError("cmp_busy_001");
      },
    }));
    const response = await request(app).post("/events/pubsub").send(pubsubEnvelope(event)).expect(409);
    expect(response.body).toEqual({
      error: "campaign_busy",
      campaignId: "cmp_busy_001",
      retryable: true,
    });
  });

  it("requires OIDC on the Pub/Sub route when the local bypass is disabled", async () => {
    const app = createApp(dependenciesFor({
      config: testConfig({
        ALLOW_UNAUTHENTICATED_PUBSUB: "false",
        PUBSUB_AUDIENCE: "https://creator-duty.invalid/events/pubsub",
        PUBSUB_SERVICE_ACCOUNT_EMAIL: "creator-duty-push@creator-duty-test.iam.gserviceaccount.com",
      }),
    }));
    await request(app).post("/events/pubsub").send(pubsubEnvelope(await fixtureEvent())).expect(401, {
      error: "missing_pubsub_token",
    });
  });

  it("protects demo actions and sends a fresh start, exact replay, then matching end", async () => {
    const seen: CreatorLiveEvent[] = [];
    const process = vi.fn(async (event: CreatorLiveEvent) => {
      seen.push(structuredClone(event));
      return resultFor(event, event.eventType === "creator.live.ended" ? "closed" : "complete");
    });
    const dependencies = dependenciesFor({
      process,
      config: testConfig({ DEMO_API_KEY: "judge-key" }),
      demoEvents: new FixtureDemoEventFactory(path.join(processCwd(), "fixtures"), () => "fresh-0001"),
    });
    const app = createApp(dependencies);

    await request(app).post("/api/demo/start").expect(401, { error: "invalid_demo_key" });
    await request(app).post("/api/demo/start").set("x-demo-key", "judge-key").expect(202);
    await request(app).post("/api/demo/replay").set("x-demo-key", "judge-key").expect(202);
    await request(app).post("/api/demo/end").set("x-demo-key", "judge-key").expect(202);

    expect(seen).toHaveLength(3);
    expect(seen[0]!.eventId).toBe("live_evt_demo_fresh0001");
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]!.eventType).toBe("creator.live.ended");
    expect(seen[2]!.stream.streamId).toBe(seen[0]!.stream.streamId);
  });

  it("enforces the durable demo-start decision before creating or dispatching an event", async () => {
    const store = new MemoryStateStore({ now: () => "2026-08-30T12:00:00.000Z" });
    const process = vi.fn(async (event: CreatorLiveEvent) => resultFor(event));
    const app = createApp(dependenciesFor({
      store,
      process,
      config: testConfig({
        DEMO_DAILY_START_LIMIT: "1",
        DEMO_START_COOLDOWN_SECONDS: "0",
      }),
    }));

    await request(app).post("/api/demo/start").expect(202);
    const rejected = await request(app).post("/api/demo/start").expect(429);
    expect(rejected.headers["retry-after"]).toBe("43200");
    expect(rejected.body).toEqual({
      error: "demo_start_quota_exceeded",
      retryAfterSeconds: 43_200,
      remaining: 0,
    });
    expect(process).toHaveBeenCalledOnce();
  });

  it("lists, selects, and gets campaigns with strict input handling", async () => {
    const store = new MemoryStateStore();
    const older = campaignRecord({ campaignId: "cmp_older_001", createdAt: "2026-08-30T10:00:00.000Z" });
    const latest = campaignRecord({ campaignId: "cmp_latest_001", createdAt: "2026-08-30T11:00:00.000Z" });
    await store.createCampaign(older);
    await store.createCampaign(latest);
    const app = createApp(dependenciesFor({ store }));

    const list = await request(app).get("/api/campaigns?limit=1").expect(200);
    expect(list.body.campaigns.map((campaign: CampaignRecord) => campaign.campaignId)).toEqual([latest.campaignId]);
    expect((await request(app).get("/api/campaigns/latest").expect(200)).body.campaign.campaignId).toBe(latest.campaignId);
    expect((await request(app).get(`/api/campaigns/${older.campaignId}`).expect(200)).body.campaign).toEqual(older);
    await request(app).get("/api/campaigns?limit=101").expect(400, { error: "invalid_limit" });
    await request(app).get("/api/campaigns/missing_campaign").expect(404, { error: "campaign_not_found" });
  });

  it("proxies local artifacts and supports byte ranges", async () => {
    const directory = await temporaryDirectory();
    const bytes = Buffer.from("creator-duty-artifact");
    await writeFile(path.join(directory, "promo.mp4"), bytes);
    const artifact = artifactRecord({ uri: "/artifacts/promo.mp4" });
    const campaign = campaignRecord({ artifacts: [artifact] });
    const store = new MemoryStateStore();
    await store.createCampaign(campaign);
    const app = createApp(dependenciesFor({
      store,
      artifactReader: new RuntimeArtifactReader({ artifactDirectory: directory }),
    }));

    const response = await request(app)
      .get(`/api/campaigns/${campaign.campaignId}/artifacts/${artifact.artifactId}`)
      .set("Range", "bytes=1-5")
      .buffer(true)
      .parse(binaryParser)
      .expect(206);
    expect(response.headers["content-range"]).toBe(`bytes 1-5/${bytes.length}`);
    expect(response.body).toEqual(bytes.subarray(1, 6));
  });

  it("proxies only a campaign-owned gs:// artifact through the injected reader", async () => {
    const artifact = artifactRecord({ uri: "gs://judging-bucket/evidence/promo.mp4" });
    const campaign = campaignRecord({ artifacts: [artifact] });
    const store = new MemoryStateStore();
    await store.createCampaign(campaign);
    const open = vi.fn<ArtifactReader["open"]>(async () => ({
      size: 4,
      contentType: "video/mp4",
      createReadStream: () => Readable.from(Buffer.from("demo")),
    }));
    const app = createApp(dependenciesFor({ store, artifactReader: { open } }));

    const response = await request(app)
      .get(`/api/campaigns/${campaign.campaignId}/artifacts/${artifact.artifactId}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(response.body).toEqual(Buffer.from("demo"));
    expect(open).toHaveBeenCalledWith(artifact);
    await request(app)
      .get(`/api/campaigns/${campaign.campaignId}/artifacts/not_owned_001`)
      .expect(404, { error: "artifact_not_found" });
    expect(open).toHaveBeenCalledOnce();
  });

  it("raises the GCS SDK stream listener budget for Node 24", async () => {
    const artifact = artifactRecord({ uri: "gs://judging-bucket/evidence/promo.mp4" });
    const createReadStream = vi.fn(() => Readable.from(Buffer.from("demo")));
    const storage = {
      bucket: () => ({
        file: () => ({
          getMetadata: async () => [{
            size: "4",
            contentType: "video/mp4",
            metadata: { sha256: artifact.sha256 },
          }],
          createReadStream,
        }),
      }),
    } as unknown as Storage;
    const reader = new RuntimeArtifactReader(
      { artifactDirectory: processCwd(), artifactBucket: "judging-bucket" },
      storage,
    );

    const resource = await reader.open(artifact);
    const stream = resource.createReadStream({ start: 0, end: 3 });

    expect(stream.getMaxListeners()).toBe(32);
    expect(createReadStream).toHaveBeenCalledWith({ start: 0, end: 3, validation: false });
  });

  it("returns generic errors with no stack or secret details", async () => {
    const app = createApp(dependenciesFor({
      process: async () => {
        throw new Error("API_TOKEN=top-secret\nstack details");
      },
    }));
    const response = await request(app).post("/events/pubsub").send(pubsubEnvelope(await fixtureEvent())).expect(500);
    expect(response.body).toEqual({ error: "workflow_failed", retryable: true });
    expect(response.text).not.toContain("top-secret");
    expect(response.text).not.toContain("stack");
  });
});

interface DependencyOverrides {
  config?: AppConfig;
  store?: MemoryStateStore;
  process?: (event: CreatorLiveEvent) => Promise<ProcessResult>;
  readiness?: () => Promise<void>;
  artifactReader?: ArtifactReader;
  demoEvents?: FixtureDemoEventFactory;
}

function dependenciesFor(overrides: DependencyOverrides = {}): CreatorDutyApplicationDependencies {
  const config = overrides.config ?? testConfig();
  const store = overrides.store ?? new MemoryStateStore();
  const process = overrides.process ?? (async (event: CreatorLiveEvent) => resultFor(event));
  return {
    config,
    store,
    orchestrator: { process },
    dispatcher: new DirectEventDispatcher(process),
    system: {
      service: "creator-duty",
      environment: config.nodeEnv,
      storeProvider: config.storeProvider,
      modelProvider: "deterministic",
      primaryModel: "deterministic-campaign-v1",
      mediaProvider: "deterministic_renderer",
      publishProvider: "deterministic_sandbox",
      eventTransport: "direct",
      criticProvider: null,
      criticModel: null,
      additionalMediaModels: [],
    },
    artifactReader: overrides.artifactReader ?? {
      open: async () => {
        throw new Error("Unexpected artifact read.");
      },
    },
    demoEvents: overrides.demoEvents ?? new FixtureDemoEventFactory(
      path.join(processCwd(), "fixtures"),
      () => "fresh-default",
    ),
    readiness: overrides.readiness ?? (async () => {}),
  };
}

function testConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    ALLOW_DEMO_TRIGGER: "true",
    ALLOW_UNAUTHENTICATED_PUBSUB: "true",
    ...overrides,
  });
}

async function fixtureEvent(): Promise<CreatorLiveEvent> {
  const raw: unknown = JSON.parse(await readFile(path.join(processCwd(), "fixtures", "live-started.json"), "utf8"));
  return creatorLiveEventSchema.parse(raw);
}

function pubsubEnvelope(event: CreatorLiveEvent): object {
  return {
    message: {
      data: Buffer.from(JSON.stringify(event), "utf8").toString("base64"),
      messageId: "pubsub-message-001",
    },
  };
}

function resultFor(
  event: CreatorLiveEvent,
  stage: ProcessResult["stage"] = "complete",
): ProcessResult {
  return {
    eventId: event.eventId,
    campaignId: "cmp_api_001",
    traceId: "trace_api_001",
    disposition: "claimed",
    stage,
    outcome: stage === "closed" ? "post_live_recap_complete" : "autonomous_campaign_complete",
  };
}

function campaignRecord(overrides: Partial<CampaignRecord> = {}): CampaignRecord {
  const createdAt = overrides.createdAt ?? "2026-08-30T10:00:00.000Z";
  return {
    campaignId: "cmp_api_001",
    eventId: "live_evt_api_001",
    creatorId: "demo_creator",
    streamId: "stream_api_001",
    traceId: "trace_api_001",
    runId: "run_api_001",
    stage: "complete",
    createdAt,
    updatedAt: createdAt,
    modelProvider: "deterministic",
    primaryModel: "deterministic-campaign-v1",
    variants: [],
    artifacts: [],
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
    ...overrides,
  };
}

function artifactRecord(overrides: Partial<CampaignArtifact> = {}): CampaignArtifact {
  return {
    artifactId: "art_promo_api_001",
    kind: "promo_video",
    uri: "/artifacts/promo.mp4",
    mimeType: "video/mp4",
    sha256: "a".repeat(64),
    width: 1080,
    height: 1920,
    durationSeconds: 12,
    createdAt: "2026-08-30T10:00:00.000Z",
    provider: "deterministic_renderer",
    ...overrides,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "creator-duty-api-"));
  temporaryDirectories.push(directory);
  return directory;
}

function binaryParser(
  response: request.Response,
  callback: (error: Error | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  response.on("end", () => callback(null, Buffer.concat(chunks)));
  response.on("error", callback);
}

function processCwd(): string {
  return process.cwd();
}
