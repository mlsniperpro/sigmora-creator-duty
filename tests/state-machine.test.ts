import { describe, expect, it } from "vitest";

import type { CampaignRecord } from "../src/domain/types.js";
import { canTransition, transitionCampaign } from "../src/orchestration/state-machine.js";

function campaign(stage: CampaignRecord["stage"]): CampaignRecord {
  return {
    campaignId: "cmp_test",
    eventId: "event_test",
    creatorId: "demo_creator",
    streamId: "stream_test",
    traceId: "a".repeat(32),
    runId: "run_test",
    stage,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    modelProvider: "deterministic",
    primaryModel: "deterministic-fixture-v1",
    variants: [],
    artifacts: [],
    receipts: [],
    steps: [],
    invocations: [],
    metrics: {
      humanActions: 0,
      manualHandoffsReplaced: 8,
      channelCount: 0,
      retryCount: 0,
      duplicatePosts: 0,
    },
  };
}

describe("campaign state machine", () => {
  it("permits the complete hero path", () => {
    const path: CampaignRecord["stage"][] = [
      "received",
      "planning",
      "producing",
      "validating",
      "publishing",
      "verifying",
      "complete",
      "recapping",
      "closed",
    ];
    for (let index = 1; index < path.length; index += 1) {
      expect(canTransition(path[index - 1]!, path[index]!)).toBe(true);
    }
  });

  it("rejects publishing before deterministic validation", () => {
    expect(() => transitionCampaign(campaign("planning"), "publishing")).toThrow(
      "Illegal campaign transition",
    );
  });

  it("allows a persisted exception to resume from the failed bounded step", () => {
    expect(canTransition("exception", "publishing")).toBe(true);
    expect(canTransition("exception", "recapping")).toBe(true);
  });
});
