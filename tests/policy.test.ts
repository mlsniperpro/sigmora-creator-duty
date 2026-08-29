import { describe, expect, it } from "vitest";

import type {
  CampaignArtifact,
  CampaignPlan,
  ChannelVariant,
  CreatorLiveEvent,
} from "../src/domain/types.js";
import { validateRelease } from "../src/tools/policy.js";

const event: CreatorLiveEvent = {
  eventId: "live_evt_demo_001",
  eventType: "creator.live.started",
  occurredAt: "2026-08-30T12:00:00.000Z",
  creatorId: "demo_creator",
  stream: {
    streamId: "stream_demo_001",
    title: "Building Creator Duty Live",
    url: "https://demo.invalid/live/creator-duty",
    sourceClipId: "clip_demo_001",
    transcriptId: "transcript_demo_001",
  },
  preauthorizationProfileId: "taskmaster_demo_v1",
};

const plan: CampaignPlan = {
  angle: "Safe autonomous campaign operations",
  hook: "Stay live while the agent handles the campaign",
  tone: "bold",
  selectedMoment: { startSeconds: 38, endSeconds: 52, rationale: "Shows the operational twist." },
  channels: ["x", "linkedin", "instagram", "youtube_shorts"],
  estimatedModelSpendUsd: 0.12,
};

const promo: CampaignArtifact = {
  artifactId: "artifact_demo_001",
  kind: "promo_video",
  uri: "/artifacts/promo.mp4",
  mimeType: "video/mp4",
  sha256: "a".repeat(64),
  width: 1080,
  height: 1920,
  durationSeconds: 12,
  createdAt: "2026-08-30T12:00:01.000Z",
  provider: "deterministic",
};

const variants: ChannelVariant[] = plan.channels.map((channel, index) => ({
  channel,
  copy: `${channel} native campaign copy with a distinct angle ${index}.`,
  ctaUrl: `https://sigmora.org/creator-duty?utm_source=${channel}`,
  hashtags: ["#AllThingsAgenticHackathon"],
}));

describe("deterministic release policy", () => {
  it("passes an immutable, preauthorized hero release", () => {
    const first = validateRelease({
      event,
      plan,
      promo,
      variants,
      allowedCreatorId: "demo_creator",
      maxModelSpendUsd: 5,
    });
    const second = validateRelease({
      event,
      plan,
      promo,
      variants,
      allowedCreatorId: "demo_creator",
      maxModelSpendUsd: 5,
    });

    expect(first.validation.passed).toBe(true);
    expect(first.validation.checks.every((check) => check.passed)).toBe(true);
    expect(first.validation.releaseHash).toBe(second.validation.releaseHash);
  });

  it("blocks authority, spend, link, claim, aspect, and channel-set violations", () => {
    const unsafeVariants: ChannelVariant[] = variants.slice(0, 3).map((variant, index) => ({
      ...variant,
      copy: index === 0 ? "Guaranteed best in the world." : variant.copy,
      ctaUrl: index === 1 ? "https://attacker.invalid/click" : variant.ctaUrl,
    }));
    const result = validateRelease({
      event: { ...event, creatorId: "unauthorized_creator" },
      plan: { ...plan, estimatedModelSpendUsd: 12 },
      promo: { ...promo, width: 1920, height: 1080 },
      variants: unsafeVariants,
      allowedCreatorId: "demo_creator",
      maxModelSpendUsd: 5,
    });

    expect(result.validation.passed).toBe(false);
    const failed = result.validation.checks.filter((check) => !check.passed).map((check) => check.code);
    expect(failed).toEqual(
      expect.arrayContaining([
        "AUTHORIZED_CREATOR",
        "EXACT_CHANNEL_SET",
        "VERTICAL_9_16",
        "MODEL_SPEND_CAP",
        "ALLOWED_LINKS",
        "SUPPORTED_CLAIMS",
      ]),
    );
  });
});
