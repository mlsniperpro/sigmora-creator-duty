import type {
  CampaignArtifact,
  CampaignPlan,
  Channel,
  ChannelVariant,
  CreatorLiveEvent,
  PolicyCheck,
  ReleaseBundle,
  ValidationRecord,
} from "../domain/types.js";
import { canonicalJson, sha256, stableId } from "../domain/ids.js";

const CHANNEL_COPY_LIMITS: Record<Channel, number> = {
  x: 280,
  linkedin: 2_200,
  instagram: 2_200,
  youtube_shorts: 100,
};

const BANNED_CLAIM_PATTERNS = [
  /\bguarantee(?:d|s)?\b/i,
  /\bnumber\s*one\b/i,
  /\b#\s*1\b/i,
  /\bbest\s+in\s+the\s+world\b/i,
  /\b100%\s+reliable\b/i,
];

export interface ReleasePolicyInput {
  event: CreatorLiveEvent;
  plan: CampaignPlan;
  promo: CampaignArtifact;
  variants: ChannelVariant[];
  allowedCreatorId: string;
  maxModelSpendUsd: number;
  now?: Date;
}

export interface ReleasePolicyResult {
  release: ReleaseBundle;
  validation: ValidationRecord;
}

export function validateRelease(input: ReleasePolicyInput): ReleasePolicyResult {
  const release: ReleaseBundle = {
    campaignId: stableId("cmp", input.event.eventId),
    creatorId: input.event.creatorId,
    artifactId: input.promo.artifactId,
    artifactSha256: input.promo.sha256,
    variants: structuredClone(input.variants),
    estimatedModelSpendUsd: input.plan.estimatedModelSpendUsd,
  };
  const releaseHash = sha256(canonicalJson(release));
  const checks: PolicyCheck[] = [];
  const add = (code: string, passed: boolean, detail: string): void => {
    checks.push({ code, passed, detail });
  };

  add(
    "AUTHORIZED_CREATOR",
    input.event.creatorId === input.allowedCreatorId,
    `Only ${input.allowedCreatorId} is preauthorized.`,
  );
  add(
    "AUTHORIZED_PROFILE",
    input.event.preauthorizationProfileId === "taskmaster_demo_v1",
    "The immutable Taskmaster demo profile must authorize this run before the event.",
  );

  const planned = new Set(input.plan.channels);
  const variantChannels = input.variants.map((variant) => variant.channel);
  const exactChannelSet =
    variantChannels.length === planned.size &&
    new Set(variantChannels).size === variantChannels.length &&
    variantChannels.every((channel) => planned.has(channel));
  add("EXACT_CHANNEL_SET", exactChannelSet, "Every planned channel has exactly one variant.");
  add(
    "DESTINATION_CAP",
    variantChannels.length >= 3 && variantChannels.length <= 4,
    "The demo profile permits three or four sandbox destinations.",
  );

  const dimensionsPass = input.promo.width === 1080 && input.promo.height === 1920;
  add("VERTICAL_9_16", dimensionsPass, "Promo must be exactly 1080×1920 (9:16)." );
  const duration = input.promo.durationSeconds ?? 0;
  add("PROMO_DURATION", duration >= 12 && duration <= 15, "Promo must be 12–15 seconds.");
  add("ONE_GENERATED_VIDEO", input.promo.kind === "promo_video", "Release contains one immutable promo video.");
  add(
    "MODEL_SPEND_CAP",
    input.plan.estimatedModelSpendUsd <= input.maxModelSpendUsd,
    `Estimated spend must be at most $${input.maxModelSpendUsd.toFixed(2)}.`,
  );

  const copyLengthsPass = input.variants.every(
    (variant) => variant.copy.length <= CHANNEL_COPY_LIMITS[variant.channel],
  );
  add("PLATFORM_COPY_LIMITS", copyLengthsPass, "Copy must fit each destination's configured limit.");

  const allowedLinks = input.variants.every((variant) => {
    const url = new URL(variant.ctaUrl);
    return url.protocol === "https:" && (url.hostname === "sigmora.org" || url.hostname.endsWith(".sigmora.org"));
  });
  add("ALLOWED_LINKS", allowedLinks, "Only HTTPS links on sigmora.org are permitted.");

  const combinedCopy = input.variants.map((variant) => variant.copy).join("\n");
  const claimsPass = BANNED_CLAIM_PATTERNS.every((pattern) => !pattern.test(combinedCopy));
  add("SUPPORTED_CLAIMS", claimsPass, "Unverified superlatives and guarantees are blocked.");

  const distinctCopy = new Set(input.variants.map((variant) => variant.copy.trim().toLowerCase())).size;
  add(
    "CHANNEL_NATIVE_VARIANTS",
    distinctCopy === input.variants.length,
    "Each destination must receive distinct platform-native copy.",
  );

  const releaseHourUtc = (input.now ?? new Date(input.event.occurredAt)).getUTCHours();
  add(
    "QUIET_HOURS",
    releaseHourUtc >= 5 && releaseHourUtc < 21,
    "The demo profile publishes only from 05:00 through 20:59 UTC.",
  );

  const validation: ValidationRecord = {
    validationId: stableId("val", releaseHash),
    releaseHash,
    passed: checks.every((check) => check.passed),
    checks,
    validatedAt: new Date().toISOString(),
  };
  return { release, validation };
}
