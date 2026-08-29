import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { creatorLiveEventSchema } from "../src/domain/schemas.js";
import { sha256 } from "../src/domain/ids.js";
import type {
  CampaignArtifact,
  CreatorLiveEvent,
  ProviderPublication,
} from "../src/domain/types.js";
import { MemoryLogger } from "../src/logging/logger.js";
import { DeterministicModelAgent } from "../src/models/index.js";
import {
  CampaignBusyError,
  CreatorDutyOrchestrator,
  type OrchestratorDependencies,
} from "../src/orchestration/orchestrator.js";
import { DeterministicMediaRenderer, type MediaRenderer } from "../src/providers/media.js";
import {
  DeterministicSandboxPublisher,
  PublishError,
  type Publisher,
  type PublishRequest,
} from "../src/providers/publisher.js";
import { FixtureSourceProvider, type SourceProvider } from "../src/providers/source.js";
import { MemoryStateStore } from "../src/storage/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Creator Duty autonomous workflow", () => {
  it("runs the real hero path, retries only one failed target, and rejects replay", async () => {
    const artifactDirectory = await temporaryDirectory();
    const store = new MemoryStateStore();
    const logger = new MemoryLogger();
    const dependencies = dependenciesFor(store, logger, {
      media: new DeterministicMediaRenderer({ artifactDirectory }),
      publisher: new DeterministicSandboxPublisher(store, { failBeforeCommitOnce: "linkedin" }),
    });
    const orchestrator = new CreatorDutyOrchestrator(dependencies);
    const event = await fixtureEvent("live-started.json");

    const result = await orchestrator.process(event);
    expect(result).toMatchObject({ disposition: "claimed", stage: "complete", outcome: "autonomous_campaign_complete" });
    const campaign = await requiredCampaign(store, result.campaignId);
    expect(campaign.artifacts.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["poster", "promo_video"]));
    expect(campaign.variants).toHaveLength(4);
    expect(new Set(campaign.variants.map(({ copy }) => copy)).size).toBe(4);
    expect(campaign.variants.every(({ ctaUrl, channel }) => new URL(ctaUrl).searchParams.get("utm_source") === channel)).toBe(true);
    expect(campaign.variants.every(({ ctaUrl }) => new URL(ctaUrl).origin === "https://sigmora.org")).toBe(true);
    expect(campaign.validation?.passed).toBe(true);
    expect(campaign.receipts).toHaveLength(4);
    expect(campaign.receipts.every(({ status }) => status === "verified")).toBe(true);
    expect(campaign.receipts.find(({ channel }) => channel === "linkedin")?.attempt).toBe(2);
    expect(campaign.receipts.filter(({ channel }) => channel !== "linkedin").every(({ attempt }) => attempt === 1)).toBe(true);
    expect(campaign.metrics).toMatchObject({ humanActions: 0, retryCount: 1, channelCount: 4, duplicatePosts: 0 });

    const validationIndex = campaign.steps.findIndex(({ tool, status }) => tool === "validate_release" && status === "succeeded");
    const firstPublishIndex = campaign.steps.findIndex(({ tool }) => tool === "publish_release");
    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(firstPublishIndex).toBeGreaterThan(validationIndex);
    expect(logger.entries.every(({ traceId }) => traceId === undefined || traceId === campaign.traceId)).toBe(true);

    const beforeReplay = campaign.receipts;
    const replay = await orchestrator.process(event);
    expect(replay).toMatchObject({ disposition: "duplicate_ignored", outcome: "duplicate_ignored" });
    expect(await store.listCampaigns()).toHaveLength(1);
    expect((await requiredCampaign(store, campaign.campaignId)).receipts).toEqual(beforeReplay);
    expect((await requiredCampaign(store, campaign.campaignId)).metrics.duplicatePosts).toBe(0);
  }, 30_000);

  it("reconciles an ambiguous committed response before any republish", async () => {
    const store = new MemoryStateStore();
    const logger = new MemoryLogger();
    const publisher = new DeterministicSandboxPublisher(store, { failAfterCommitOnce: "instagram" });
    const orchestrator = new CreatorDutyOrchestrator(
      dependenciesFor(store, logger, { media: new FakeMediaRenderer(), publisher }),
    );

    const result = await orchestrator.process(await fixtureEvent("live-started.json"));
    const campaign = await requiredCampaign(store, result.campaignId);
    expect(campaign.stage).toBe("complete");
    expect(campaign.receipts.find(({ channel }) => channel === "instagram")).toMatchObject({
      status: "verified",
      attempt: 1,
    });
    expect(campaign.metrics.retryCount).toBe(0);
  });

  it("attaches the live-ended event to the durable campaign and closes with a recap", async () => {
    const store = new MemoryStateStore();
    const logger = new MemoryLogger();
    const orchestrator = new CreatorDutyOrchestrator(
      dependenciesFor(store, logger, { media: new FakeMediaRenderer() }),
    );
    const started = await orchestrator.process(await fixtureEvent("live-started.json"));
    const ended = await orchestrator.process(await fixtureEvent("live-ended.json"));

    expect(ended).toMatchObject({ campaignId: started.campaignId, disposition: "claimed", stage: "closed" });
    expect(await store.listCampaigns()).toHaveLength(1);
    const campaign = await requiredCampaign(store, started.campaignId);
    expect(campaign.recap?.questionClusters.length).toBeGreaterThan(0);
    expect(campaign.outcome).toBe("post_live_recap_complete");

    const replay = await orchestrator.process(await fixtureEvent("live-ended.json"));
    expect(replay.disposition).toBe("duplicate_ignored");
  });

  it("blocks an event outside the preauthorized creator boundary before publishing", async () => {
    const store = new MemoryStateStore();
    const logger = new MemoryLogger();
    const publisher = new CountingPublisher();
    const orchestrator = new CreatorDutyOrchestrator(
      dependenciesFor(store, logger, { media: new FakeMediaRenderer(), publisher }),
    );
    const event = { ...(await fixtureEvent("live-started.json")), creatorId: "not_authorized" };
    const result = await orchestrator.process(event);
    const campaign = await requiredCampaign(store, result.campaignId);

    expect(result.stage).toBe("blocked");
    expect(campaign.validation?.checks.find(({ code }) => code === "AUTHORIZED_CREATOR")?.passed).toBe(false);
    expect(publisher.publishCalls).toBe(0);
    expect(campaign.receipts).toEqual([]);
  });

  it("uses an execution lease to reject an overlapping delivery", async () => {
    const store = new MemoryStateStore();
    const logger = new MemoryLogger();
    let releaseSource!: () => void;
    const sourceGate = new Promise<void>((resolve) => {
      releaseSource = resolve;
    });
    const delegate = new FixtureSourceProvider(path.join(process.cwd(), "fixtures"));
    const blockingSource: SourceProvider = {
      name: "blocking_fixture",
      async load(event) {
        await sourceGate;
        return delegate.load(event);
      },
    };
    const orchestrator = new CreatorDutyOrchestrator(
      dependenciesFor(store, logger, { media: new FakeMediaRenderer(), source: blockingSource }),
    );
    const event = await fixtureEvent("live-started.json");
    const first = orchestrator.process(event);
    await until(async () => (await store.getLatestCampaign())?.executionLease !== undefined);

    await expect(orchestrator.process(event)).rejects.toBeInstanceOf(CampaignBusyError);
    releaseSource();
    await expect(first).resolves.toMatchObject({ stage: "complete" });
  });

  it("persists a terminal provider failure and moves the campaign to exception", async () => {
    const store = new MemoryStateStore();
    const logger = new MemoryLogger();
    const orchestrator = new CreatorDutyOrchestrator(
      dependenciesFor(store, logger, {
        media: new FakeMediaRenderer(),
        publisher: new TerminalFailurePublisher(),
      }),
    );
    await expect(orchestrator.process(await fixtureEvent("live-started.json"))).rejects.toThrow(
      "Terminal publication failure",
    );
    const campaign = await store.getLatestCampaign();
    expect(campaign?.stage).toBe("exception");
    expect(campaign?.receipts[0]).toMatchObject({ status: "failed", errorCode: "TARGET_REJECTED" });
  });
});

function dependenciesFor(
  store: MemoryStateStore,
  logger: MemoryLogger,
  overrides: Partial<OrchestratorDependencies> = {},
): OrchestratorDependencies {
  return {
    config: loadConfig({ NODE_ENV: "test", MAX_MODEL_SPEND_USD: "5" }),
    store,
    source: new FixtureSourceProvider(path.join(process.cwd(), "fixtures")),
    model: new DeterministicModelAgent(),
    media: new FakeMediaRenderer(),
    publisher: new DeterministicSandboxPublisher(store),
    logger,
    retryDelay: async () => undefined,
    ...overrides,
  };
}

class FakeMediaRenderer implements MediaRenderer {
  public readonly name = "fake_media";

  public async renderPromo(): Promise<CampaignArtifact[]> {
    return [
      {
        artifactId: "art_promo_test",
        kind: "promo_video",
        uri: "/artifacts/test.mp4",
        mimeType: "video/mp4",
        sha256: sha256("test-promo"),
        width: 1080,
        height: 1920,
        durationSeconds: 12,
        createdAt: "2026-08-30T12:00:01.000Z",
        provider: this.name,
      },
    ];
  }
}

class CountingPublisher implements Publisher {
  public readonly name = "counting";
  public publishCalls = 0;

  public async publish(request: PublishRequest): Promise<ProviderPublication> {
    this.publishCalls += 1;
    return publication(request);
  }

  public async lookup(): Promise<ProviderPublication | undefined> {
    return undefined;
  }

  public async verify(): Promise<boolean> {
    return true;
  }
}

class TerminalFailurePublisher implements Publisher {
  public readonly name = "terminal_failure";

  public async publish(): Promise<ProviderPublication> {
    throw new PublishError("Target rejected the immutable release.", "TARGET_REJECTED", false, false);
  }

  public async lookup(): Promise<ProviderPublication | undefined> {
    return undefined;
  }

  public async verify(): Promise<boolean> {
    return false;
  }
}

function publication(request: PublishRequest): ProviderPublication {
  return {
    idempotencyKey: request.idempotencyKey,
    channel: request.channel,
    providerPostId: `post_${request.channel}`,
    providerUrl: `https://sandbox.invalid/posts/${request.channel}`,
    committedAt: "2026-08-30T12:00:05.000Z",
  };
}

async function fixtureEvent(name: string): Promise<CreatorLiveEvent> {
  return creatorLiveEventSchema.parse(
    JSON.parse(await readFile(path.join(process.cwd(), "fixtures", name), "utf8")),
  );
}

async function requiredCampaign(store: MemoryStateStore, campaignId: string) {
  const campaign = await store.getCampaign(campaignId);
  if (!campaign) throw new Error(`Missing campaign ${campaignId}.`);
  return campaign;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "creator-duty-orchestrator-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition did not become true.");
}
