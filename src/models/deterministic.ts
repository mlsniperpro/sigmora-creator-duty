import { canonicalJson, stableId } from "../domain/ids.js";
import {
  campaignPlanSchema,
  channelVariantsSchema,
  recapSchema,
} from "../domain/schemas.js";
import type {
  CampaignPlan,
  Channel,
  ChannelVariant,
  LiveSource,
  ModelInvocation,
  RecapResult,
} from "../domain/types.js";
import { ModelAgentError } from "./errors.js";
import type {
  DraftChannelVariantsInput,
  ModelAgent,
  ModelCallResult,
  PlanCampaignInput,
  PrepareRecapInput,
} from "./types.js";

const DETERMINISTIC_MODEL = "creator-duty-deterministic-v1";
const QUESTION_GROUPS = [
  {
    theme: "Reliability and duplicate protection",
    matches: /duplicate|retry|fail|receipt|reliab/i,
    suggestedAnswer:
      "Creator Duty checkpoints each destination and uses per-target idempotency before retrying only unfinished work.",
  },
  {
    theme: "Google architecture and model boundary",
    matches: /google|gemini|cloud|model|caption|different/i,
    suggestedAnswer:
      "Gemini makes bounded campaign choices while Cloud Run, Firestore, and deterministic policy control execution and authority.",
  },
  {
    theme: "Creator authority and connections",
    matches: /approval|account|connect|publish|control/i,
    suggestedAnswer:
      "The demo runs inside a narrow preauthorization profile and never gives credentials or account administration authority to the model.",
  },
] as const;

export interface DeterministicModelAgentOptions {
  now?: () => Date;
}

/** A reproducible local provider; it makes no network calls and has no secrets. */
export class DeterministicModelAgent implements ModelAgent {
  public readonly provider = "deterministic" as const;
  public readonly model = DETERMINISTIC_MODEL;
  private readonly now: () => Date;

  public constructor(options: DeterministicModelAgentOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  public async planCampaign(
    input: PlanCampaignInput,
  ): Promise<ModelCallResult<CampaignPlan>> {
    assertUsableSource(input.source);
    const segment = selectPromotionalSegment(input.source);
    const startSeconds = Math.max(0, segment.startSeconds);
    const endSeconds = Math.min(input.source.durationSeconds, startSeconds + 15);
    const title = readableTitle(input.event.stream.title);

    const value = campaignPlanSchema.parse({
      angle: truncate(
        `Turn ${title} into a safe, verified cross-channel campaign while the creator stays live.`,
        180,
      ),
      hook: truncate(`Stay live: ${title} becomes an operated campaign.`, 140),
      tone: "calm",
      selectedMoment: {
        startSeconds,
        endSeconds,
        rationale:
          "This moment explains the operational value, safety boundary, and visible proof of action.",
      },
      channels: ["x", "linkedin", "instagram", "youtube_shorts"],
      estimatedModelSpendUsd: 0,
    });
    assertPlanWithinSource(value, input.source, this.model);
    return deterministicResult("plan_campaign", input, value, this.now);
  }

  public async draftChannelVariants(
    input: DraftChannelVariantsInput,
  ): Promise<ModelCallResult<ChannelVariant[]>> {
    const title = readableTitle(input.event.stream.title);
    const copies: Record<Channel, string> = {
      x: truncate(
        `${input.plan.hook} Creator Duty plans, produces, validates, publishes, and recovers the campaign while I stay with the audience.`,
        280,
      ),
      linkedin: truncate(
        `Going live should make a creator more present, not create another operations shift. During ${title}, Creator Duty turns the live event into a produced and verified campaign, with scoped authority, receipts, targeted retry, and duplicate protection.`,
        2_200,
      ),
      instagram: truncate(
        `I went live and Creator Duty started working in the background. It found the campaign moment, prepared the vertical promo, adapted every destination, checked the release, and returned receipts—without pulling me away from the audience.`,
        2_200,
      ),
      youtube_shorts: truncate(
        `Stay live while Creator Duty produces and verifies the campaign—even when one target fails.`,
        100,
      ),
    };
    const hashtags: Record<Channel, string[]> = {
      x: ["#AllThingsAgenticHackathon", "#Gemini", "#GoogleCloud"],
      linkedin: ["#AllThingsAgenticHackathon", "#AIAgents", "#CreatorEconomy"],
      instagram: ["#AllThingsAgenticHackathon", "#CreatorTools", "#BuildInPublic"],
      youtube_shorts: ["#AllThingsAgenticHackathon", "#AIAgents"],
    };
    const requested = new Set(input.plan.channels);
    const parsed = channelVariantsSchema.parse({
      variants: input.plan.channels.map((channel) => ({
        channel,
        copy: copies[channel],
        ctaUrl: input.ctaUrl,
        hashtags: hashtags[channel],
      })),
    });
    assertExactVariants(parsed.variants, requested, input.ctaUrl, this.model);
    return deterministicResult("draft_channel_variants", input, parsed.variants, this.now);
  }

  public async prepareRecap(
    input: PrepareRecapInput,
  ): Promise<ModelCallResult<RecapResult>> {
    const pending = [...input.source.audienceQuestions];
    const questionClusters: RecapResult["questionClusters"] = QUESTION_GROUPS.flatMap((group) => {
      const questions = pending.filter((question) => group.matches.test(question));
      for (const question of questions) pending.splice(pending.indexOf(question), 1);
      return questions.length === 0
        ? []
        : [
            {
              theme: group.theme,
              questions: questions.slice(0, 10),
              suggestedAnswer: group.suggestedAnswer,
            },
          ];
    });
    if (pending.length > 0) {
      questionClusters.push({
        theme: "Audience follow-up",
        questions: pending.slice(0, 10),
        suggestedAnswer:
          "These questions are preserved as a reviewable follow-up cluster rather than answered or published automatically.",
      });
    }

    const value = recapSchema.parse({
      headline: truncate(`Creator Duty completed the campaign for ${readableTitle(input.event.stream.title)}`, 160),
      summary: truncate(
        "The livestream event became a produced, channel-adapted, policy-checked campaign with durable receipts, targeted failure recovery, and duplicate-event protection.",
        1_200,
      ),
      questionClusters,
    });
    return deterministicResult("prepare_recap", input, value, this.now);
  }
}

export function assertPlanWithinSource(
  plan: CampaignPlan,
  source: LiveSource,
  model: string,
): void {
  const duration = plan.selectedMoment.endSeconds - plan.selectedMoment.startSeconds;
  if (
    plan.selectedMoment.startSeconds < 0 ||
    plan.selectedMoment.endSeconds > source.durationSeconds ||
    duration < 12 ||
    duration > 15
  ) {
    throw new ModelAgentError(
      "MODEL_OUTPUT_INVARIANT",
      `Model ${model} selected a promotional moment outside the required 12–15 second source boundary.`,
      { model, purpose: "plan_campaign" },
    );
  }
}

export function assertExactVariants(
  variants: ChannelVariant[],
  plannedChannels: ReadonlySet<Channel>,
  ctaUrl: string,
  model: string,
): void {
  const actualChannels = variants.map((variant) => variant.channel);
  const exactSet =
    actualChannels.length === plannedChannels.size &&
    new Set(actualChannels).size === actualChannels.length &&
    actualChannels.every((channel) => plannedChannels.has(channel));
  const exactLinks = variants.every((variant) => variant.ctaUrl === ctaUrl);
  if (!exactSet || !exactLinks) {
    throw new ModelAgentError(
      "MODEL_OUTPUT_INVARIANT",
      `Model ${model} changed the authorized channel set or campaign URL.`,
      { model, purpose: "draft_channel_variants" },
    );
  }
}

function assertUsableSource(source: LiveSource): void {
  if (
    !Number.isFinite(source.durationSeconds) ||
    source.durationSeconds < 12 ||
    source.transcript.length === 0
  ) {
    throw new ModelAgentError(
      "MODEL_OUTPUT_INVARIANT",
      "A campaign plan requires a transcript and at least 12 seconds of source media.",
      { model: DETERMINISTIC_MODEL, purpose: "plan_campaign" },
    );
  }
}

function selectPromotionalSegment(source: LiveSource): LiveSource["transcript"][number] {
  const ranked = source.transcript
    .map((segment, index) => ({
      segment,
      index,
      score: (segment.text.match(/agent|safe|policy|receipt|failure|duplicate|creator/gi) ?? []).length,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = ranked[0]?.segment;
  if (selected === undefined) {
    throw new ModelAgentError(
      "MODEL_OUTPUT_INVARIANT",
      "The deterministic provider could not select a transcript segment.",
      { model: DETERMINISTIC_MODEL, purpose: "plan_campaign" },
    );
  }
  return selected;
}

function readableTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length >= 3 ? normalized : "this creator livestream";
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

function deterministicResult<T>(
  purpose: ModelInvocation["purpose"],
  input: unknown,
  value: T,
  now: () => Date,
): ModelCallResult<T> {
  const responseId = stableId("dres", canonicalJson({ purpose, input, value }));
  const recordedAt = now().toISOString();
  return {
    value,
    invocation: {
      invocationId: stableId("minv", responseId),
      purpose,
      model: DETERMINISTIC_MODEL,
      provider: "deterministic",
      responseId,
      modelVersion: DETERMINISTIC_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      createdAt: recordedAt,
    },
    evidence: {
      sdk: "deterministic",
      apiSurface: "local_fixture",
      provider: "deterministic",
      requestedModel: DETERMINISTIC_MODEL,
      resolvedModel: DETERMINISTIC_MODEL,
      responseId,
      finishReason: "DETERMINISTIC",
      recordedAt,
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    },
  };
}
