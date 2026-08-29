import type {
  CampaignPlan,
  ChannelVariant,
  CreatorLiveEvent,
  CriticResult,
  LiveSource,
  ModelInvocation,
  RecapResult,
} from "../domain/types.js";

export interface PlanCampaignInput {
  event: CreatorLiveEvent;
  source: LiveSource;
  maxEstimatedModelSpendUsd: number;
}

export interface DraftChannelVariantsInput {
  event: CreatorLiveEvent;
  source: LiveSource;
  plan: CampaignPlan;
  ctaUrl: string;
}

export interface PrepareRecapInput {
  event: CreatorLiveEvent;
  source: LiveSource;
  plan?: CampaignPlan;
  variants?: ChannelVariant[];
}

export interface CritiqueCampaignInput {
  plan: CampaignPlan;
  variants: ChannelVariant[];
  policySummary: string;
}

export interface ModelEvidence {
  sdk: "@google/genai" | "deterministic";
  apiSurface: "models.generateContent" | "local_fixture";
  provider: ModelInvocation["provider"];
  requestedModel: string;
  resolvedModel: string;
  responseId: string;
  finishReason: string;
  recordedAt: string;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface RecordedModelInvocation extends ModelInvocation {
  responseId: string;
  modelVersion: string;
}

export interface ModelCallResult<T> {
  value: T;
  invocation: RecordedModelInvocation;
  evidence: ModelEvidence;
}

/**
 * The model is allowed to make bounded creative choices only. Callers must run
 * the returned values through the deterministic release policy before any
 * publishing side effect.
 */
export interface ModelAgent {
  readonly provider: ModelInvocation["provider"];
  readonly model: string;

  planCampaign(input: PlanCampaignInput): Promise<ModelCallResult<CampaignPlan>>;

  draftChannelVariants(
    input: DraftChannelVariantsInput,
  ): Promise<ModelCallResult<ChannelVariant[]>>;

  prepareRecap(input: PrepareRecapInput): Promise<ModelCallResult<RecapResult>>;
}

/** Advisory only. A critic finding can never authorize or publish a release. */
export interface CampaignCritic {
  readonly provider: ModelInvocation["provider"];
  readonly model: string;

  critique(input: CritiqueCampaignInput): Promise<ModelCallResult<CriticResult>>;
}
