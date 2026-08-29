import { describe, expect, it } from "vitest";

import type {
  CampaignRecord,
  CreatorLiveEvent,
  ProviderPublication,
} from "../src/domain/types.js";
import {
  CampaignAlreadyExistsError,
  MemoryStateStore,
  ProviderPublicationConflictError,
  StorageIntegrityError,
} from "../src/storage/index.js";

function liveEvent(
  eventId = "live_evt_demo_001",
  streamId = "stream_demo_001",
): CreatorLiveEvent {
  return {
    eventId,
    eventType: "creator.live.started",
    occurredAt: "2026-08-30T12:00:00.000Z",
    creatorId: "demo_creator",
    stream: {
      streamId,
      title: "Building Creator Duty Live",
      url: "https://demo.invalid/live/creator-duty",
      sourceClipId: "clip_demo_001",
      transcriptId: "transcript_demo_001",
    },
    preauthorizationProfileId: "taskmaster_demo_v1",
  };
}

function campaign(
  event: CreatorLiveEvent,
  campaignId = `campaign_${event.eventId}`,
  createdAt = event.occurredAt,
): CampaignRecord {
  return {
    campaignId,
    eventId: event.eventId,
    creatorId: event.creatorId,
    streamId: event.stream.streamId,
    traceId: `trace_${event.eventId}`,
    runId: `run_${event.eventId}`,
    stage: "received",
    createdAt,
    updatedAt: createdAt,
    modelProvider: "deterministic",
    primaryModel: "deterministic-v1",
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
  };
}

describe("MemoryStateStore event claims", () => {
  it("creates exactly one campaign under concurrent delivery of the same event", async () => {
    const store = new MemoryStateStore();
    const event = liveEvent();

    const claims = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        store.claimEvent(event, campaign(event, `campaign_candidate_${index}`)),
      ),
    );

    expect(claims.filter(({ disposition }) => disposition === "claimed")).toHaveLength(1);
    expect(claims.filter(({ disposition }) => disposition === "resumed")).toHaveLength(39);
    expect(new Set(claims.map(({ campaignId }) => campaignId))).toHaveLength(1);
    expect(await store.listCampaigns()).toHaveLength(1);
  });

  it("resumes a non-complete campaign and ignores a replay after completion", async () => {
    let tick = 0;
    const store = new MemoryStateStore({
      now: () => `2026-08-30T12:00:0${tick++}.000Z`,
    });
    const event = liveEvent();
    const initial = campaign(event);

    const first = await store.claimEvent(event, initial);
    await store.updateCampaign(first.campaignId, (draft) => {
      draft.stage = "publishing";
    });
    const resumed = await store.claimEvent(event, campaign(event, "never_created"));
    expect(resumed).toMatchObject({
      campaignId: initial.campaignId,
      disposition: "resumed",
    });

    await store.updateCampaign(first.campaignId, (draft) => {
      draft.stage = "complete";
      draft.completedAt = "2026-08-30T12:00:08.000Z";
    });
    const duplicate = await store.claimEvent(event, campaign(event, "also_never_created"));
    expect(duplicate).toMatchObject({
      campaignId: initial.campaignId,
      disposition: "duplicate_ignored",
    });
    expect(await store.listCampaigns()).toHaveLength(1);
  });

  it("rejects reuse of an event ID with a different canonical payload", async () => {
    const store = new MemoryStateStore();
    const event = liveEvent();
    await store.claimEvent(event, campaign(event));

    const conflictingEvent: CreatorLiveEvent = {
      ...event,
      stream: {
        ...event.stream,
        title: "A different stream title",
      },
    };
    await expect(
      store.claimEvent(conflictingEvent, campaign(conflictingEvent, "conflicting_campaign")),
    ).rejects.toThrow(`Event ID ${event.eventId} was replayed with a different payload.`);
    expect(await store.listCampaigns()).toHaveLength(1);
  });

  it("can claim a live-ended event against the existing stream campaign", async () => {
    const store = new MemoryStateStore();
    const started = liveEvent();
    const existing = campaign(started);
    await store.claimEvent(started, existing);

    const ended: CreatorLiveEvent = {
      ...started,
      eventId: "live_evt_demo_ended_001",
      eventType: "creator.live.ended",
      occurredAt: "2026-08-30T13:00:00.000Z",
    };
    const claim = await store.claimEvent(ended, existing);

    expect(claim).toMatchObject({
      eventId: ended.eventId,
      campaignId: existing.campaignId,
      disposition: "claimed",
    });
    expect(await store.listCampaigns()).toHaveLength(1);

    await store.updateCampaign(existing.campaignId, (draft) => {
      draft.stage = "closed";
      draft.closedAt = "2026-08-30T13:00:05.000Z";
    });
    expect(await store.claimEvent(ended, existing)).toMatchObject({
      campaignId: existing.campaignId,
      disposition: "duplicate_ignored",
    });
  });
});

describe("MemoryStateStore global demo-start quota", () => {
  it("atomically admits no more than the daily limit under concurrency", async () => {
    const store = new MemoryStateStore({
      now: () => "2026-08-30T12:00:00.000Z",
    });

    const decisions = await Promise.all(
      Array.from({ length: 100 }, () =>
        store.reserveDemoStart({ dailyLimit: 7, cooldownSeconds: 0 }),
      ),
    );

    expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(7);
    expect(decisions.filter(({ allowed }) => !allowed)).toHaveLength(93);
    expect(decisions.filter(({ allowed }) => allowed).map(({ remaining }) => remaining)).toEqual([
      6, 5, 4, 3, 2, 1, 0,
    ]);
    expect(decisions.filter(({ allowed }) => !allowed)).toEqual(
      Array.from({ length: 93 }, () => ({
        allowed: false,
        retryAfterSeconds: 43_200,
        remaining: 0,
      })),
    );
  });

  it("enforces cooldown without consuming another daily slot", async () => {
    let now = "2026-08-30T12:00:00.000Z";
    const store = new MemoryStateStore({ now: () => now });
    const policy = { dailyLimit: 3, cooldownSeconds: 60 };

    await expect(store.reserveDemoStart(policy)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
      remaining: 2,
    });
    now = "2026-08-30T12:00:30.250Z";
    await expect(store.reserveDemoStart(policy)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 30,
      remaining: 2,
    });
    now = "2026-08-30T12:01:00.000Z";
    await expect(store.reserveDemoStart(policy)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
      remaining: 1,
    });
  });

  it("resets the daily count at UTC rollover while preserving cooldown", async () => {
    let now = "2026-08-30T23:59:50.000Z";
    const store = new MemoryStateStore({ now: () => now });
    const policy = { dailyLimit: 1, cooldownSeconds: 30 };

    await expect(store.reserveDemoStart(policy)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    await expect(store.reserveDemoStart(policy)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 30,
      remaining: 0,
    });

    now = "2026-08-31T00:00:00.000Z";
    await expect(store.reserveDemoStart(policy)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 20,
      remaining: 1,
    });
    now = "2026-08-31T00:00:20.000Z";
    await expect(store.reserveDemoStart(policy)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
      remaining: 0,
    });
  });

  it("rejects unsafe policy values and invalid storage time", async () => {
    const store = new MemoryStateStore();
    await expect(
      store.reserveDemoStart({ dailyLimit: 0, cooldownSeconds: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      store.reserveDemoStart({ dailyLimit: 1, cooldownSeconds: -1 }),
    ).rejects.toBeInstanceOf(RangeError);

    const invalidClockStore = new MemoryStateStore({ now: () => "not-a-timestamp" });
    await expect(
      invalidClockStore.reserveDemoStart({ dailyLimit: 1, cooldownSeconds: 0 }),
    ).rejects.toBeInstanceOf(StorageIntegrityError);
  });
});

describe("MemoryStateStore campaign state", () => {
  it("grants one execution lease, rejects overlap, and permits takeover only after expiry", async () => {
    let now = "2026-08-30T12:00:00.000Z";
    const store = new MemoryStateStore({ now: () => now });
    const event = liveEvent();
    const initial = campaign(event);
    await store.createCampaign(initial);

    expect(await store.acquireCampaignLease(initial.campaignId, "worker-a", 30_000)).toBe(true);
    expect(await store.acquireCampaignLease(initial.campaignId, "worker-b", 30_000)).toBe(false);
    expect(await store.acquireCampaignLease(initial.campaignId, "worker-a", 30_000)).toBe(true);

    now = "2026-08-30T12:00:31.000Z";
    expect(await store.acquireCampaignLease(initial.campaignId, "worker-b", 30_000)).toBe(true);
    await store.releaseCampaignLease(initial.campaignId, "worker-a");
    expect((await store.getCampaign(initial.campaignId))?.executionLease?.ownerId).toBe("worker-b");
    await store.releaseCampaignLease(initial.campaignId, "worker-b");
    expect((await store.getCampaign(initial.campaignId))?.executionLease).toBeUndefined();
  });

  it("serializes concurrent updates without losing writes", async () => {
    let tick = 0;
    const store = new MemoryStateStore({
      now: () => `2026-08-30T12:00:${String(tick++).padStart(2, "0")}.000Z`,
    });
    const event = liveEvent();
    const initial = campaign(event);
    await store.createCampaign(initial);

    await Promise.all(
      Array.from({ length: 50 }, () =>
        store.updateCampaign(initial.campaignId, (draft) => {
          draft.metrics.retryCount += 1;
        }),
      ),
    );

    expect((await store.getCampaign(initial.campaignId))?.metrics.retryCount).toBe(50);
  });

  it("isolates stored state from caller-owned inputs, outputs, and updater failures", async () => {
    const store = new MemoryStateStore();
    const event = liveEvent();
    const initial = campaign(event);
    await store.createCampaign(initial);

    initial.metrics.retryCount = 99;
    const firstRead = await store.getCampaign(initial.campaignId);
    expect(firstRead?.metrics.retryCount).toBe(0);
    if (!firstRead) {
      throw new Error("Expected campaign.");
    }
    firstRead.metrics.retryCount = 88;
    expect((await store.getCampaign(initial.campaignId))?.metrics.retryCount).toBe(0);

    await expect(
      store.updateCampaign(initial.campaignId, (draft) => {
        draft.metrics.retryCount = 77;
        throw new Error("stop update");
      }),
    ).rejects.toThrow("stop update");
    expect((await store.getCampaign(initial.campaignId))?.metrics.retryCount).toBe(0);

    await expect(
      store.updateCampaign(initial.campaignId, (draft) => ({
        ...draft,
        campaignId: "different_campaign",
      })),
    ).rejects.toBeInstanceOf(StorageIntegrityError);
    expect((await store.getCampaign(initial.campaignId))?.campaignId).toBe(initial.campaignId);
    await expect(store.createCampaign(campaign(event))).rejects.toBeInstanceOf(
      CampaignAlreadyExistsError,
    );
  });

  it("returns deterministic stream, latest, and bounded list lookups", async () => {
    const store = new MemoryStateStore();
    const oldestEvent = liveEvent("live_evt_oldest_001", "stream_shared_001");
    const middleEvent = liveEvent("live_evt_middle_001", "stream_other_001");
    const latestEvent = liveEvent("live_evt_latest_001", "stream_shared_001");
    await store.createCampaign(campaign(oldestEvent, "campaign_oldest", "2026-08-30T10:00:00.000Z"));
    await store.createCampaign(campaign(middleEvent, "campaign_middle", "2026-08-30T11:00:00.000Z"));
    await store.createCampaign(campaign(latestEvent, "campaign_latest", "2026-08-30T12:00:00.000Z"));

    expect((await store.getCampaignByStream("stream_shared_001"))?.campaignId).toBe(
      "campaign_latest",
    );
    expect((await store.getLatestCampaign())?.campaignId).toBe("campaign_latest");
    expect((await store.listCampaigns(2)).map(({ campaignId }) => campaignId)).toEqual([
      "campaign_latest",
      "campaign_middle",
    ]);
    expect(await store.listCampaigns(0)).toEqual([]);
  });
});

describe("MemoryStateStore provider publication ledger", () => {
  it("is write-once, concurrent, idempotent, and clone-isolated", async () => {
    const store = new MemoryStateStore();
    const publication: ProviderPublication = {
      idempotencyKey: "campaign_demo:x:release_001",
      channel: "x",
      providerPostId: "sandbox_post_001",
      providerUrl: "https://demo.invalid/posts/sandbox_post_001",
      committedAt: "2026-08-30T12:00:05.000Z",
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.recordProviderPublication(publication)),
    );
    expect(results).toEqual(Array.from({ length: 20 }, () => publication));

    publication.providerPostId = "mutated_by_caller";
    const persisted = await store.getProviderPublication(publication.idempotencyKey);
    expect(persisted?.providerPostId).toBe("sandbox_post_001");
    if (!persisted) {
      throw new Error("Expected publication.");
    }
    persisted.providerPostId = "mutated_read";
    expect((await store.getProviderPublication(publication.idempotencyKey))?.providerPostId).toBe(
      "sandbox_post_001",
    );

    await expect(
      store.recordProviderPublication({
        ...publication,
        providerPostId: "different_post",
      }),
    ).rejects.toBeInstanceOf(ProviderPublicationConflictError);
  });
});
