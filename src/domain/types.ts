export const CHANNELS = ["x", "linkedin", "instagram", "youtube_shorts"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CAMPAIGN_STAGES = [
  "received",
  "planning",
  "producing",
  "validating",
  "publishing",
  "verifying",
  "complete",
  "recapping",
  "closed",
  "blocked",
  "exception",
] as const;
export type CampaignStage = (typeof CAMPAIGN_STAGES)[number];

export type EventType = "creator.live.started" | "creator.live.ended";

export interface CreatorLiveEvent {
  eventId: string;
  eventType: EventType;
  occurredAt: string;
  creatorId: string;
  stream: {
    streamId: string;
    title: string;
    url: string;
    sourceClipId: string;
    transcriptId: string;
  };
  preauthorizationProfileId: string;
}

export interface PubSubPushEnvelope {
  deliveryAttempt?: number;
  message: {
    data: string;
    messageId?: string;
    message_id?: string;
    publishTime?: string;
    publish_time?: string;
    orderingKey?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
}

export type ClaimDisposition = "claimed" | "resumed" | "duplicate_ignored";

export interface EventClaim {
  eventId: string;
  campaignId: string;
  disposition: ClaimDisposition;
  claimedAt: string;
  eventType: EventType;
}

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface StepRecord {
  stepId: string;
  tool: string;
  status: StepStatus;
  attempt: number;
  startedAt?: string;
  completedAt?: string;
  outcome?: string;
  error?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface LiveSource {
  sourceClipId: string;
  transcriptId: string;
  durationSeconds: number;
  transcript: Array<{
    startSeconds: number;
    endSeconds: number;
    text: string;
  }>;
  audienceQuestions: string[];
}

export interface CampaignPlan {
  angle: string;
  hook: string;
  tone: "calm" | "bold" | "educational" | "playful";
  selectedMoment: {
    startSeconds: number;
    endSeconds: number;
    rationale: string;
  };
  channels: Channel[];
  estimatedModelSpendUsd: number;
}

export interface ChannelVariant {
  channel: Channel;
  copy: string;
  ctaUrl: string;
  hashtags: string[];
}

export type ArtifactKind = "poster" | "promo_video" | "veo_broll" | "lyria_music";

export interface CampaignArtifact {
  artifactId: string;
  kind: ArtifactKind;
  uri: string;
  mimeType: string;
  sha256: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  model?: string;
  operationId?: string;
  prompt?: string;
  createdAt: string;
  provider: string;
}

export interface CriticFinding {
  code: string;
  severity: "info" | "warning" | "high";
  channel?: Channel;
  message: string;
}

export interface CriticResult {
  model: string;
  findings: CriticFinding[];
  createdAt: string;
}

export interface PolicyCheck {
  code: string;
  passed: boolean;
  detail: string;
}

export interface ValidationRecord {
  validationId: string;
  releaseHash: string;
  passed: boolean;
  checks: PolicyCheck[];
  validatedAt: string;
}

export type ReceiptStatus = "pending" | "retrying" | "verified" | "failed";

export interface PublicationReceipt {
  receiptId: string;
  campaignId: string;
  channel: Channel;
  idempotencyKey: string;
  status: ReceiptStatus;
  attempt: number;
  providerPostId?: string;
  providerUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  committedAt?: string;
  verifiedAt?: string;
}

export interface ProviderPublication {
  idempotencyKey: string;
  channel: Channel;
  providerPostId: string;
  providerUrl: string;
  committedAt: string;
}

export interface ModelInvocation {
  invocationId: string;
  purpose: "plan_campaign" | "draft_channel_variants" | "prepare_recap" | "critic";
  model: string;
  provider: "gemini_api" | "vertex_ai" | "deterministic";
  responseId?: string;
  modelVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: string;
}

export interface RecapResult {
  headline: string;
  summary: string;
  questionClusters: Array<{
    theme: string;
    questions: string[];
    suggestedAnswer: string;
  }>;
}

export interface CampaignRecord {
  campaignId: string;
  eventId: string;
  creatorId: string;
  streamId: string;
  traceId: string;
  runId: string;
  stage: CampaignStage;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  closedAt?: string;
  modelProvider: string;
  primaryModel: string;
  plan?: CampaignPlan;
  variants: ChannelVariant[];
  artifacts: CampaignArtifact[];
  critic?: CriticResult;
  validation?: ValidationRecord;
  receipts: PublicationReceipt[];
  steps: StepRecord[];
  invocations: ModelInvocation[];
  recap?: RecapResult;
  outcome?: string;
  executionLease?: {
    ownerId: string;
    acquiredAt: string;
    expiresAt: string;
  };
  metrics: {
    humanActions: number;
    manualHandoffsReplaced: number;
    channelCount: number;
    retryCount: number;
    duplicatePosts: number;
    elapsedMs?: number;
    recoveryMs?: number;
  };
}

export interface ProcessResult {
  eventId: string;
  campaignId: string;
  traceId: string;
  disposition: ClaimDisposition;
  stage: CampaignStage;
  outcome: string;
}

export interface ReleaseBundle {
  campaignId: string;
  creatorId: string;
  artifactId: string;
  artifactSha256: string;
  variants: ChannelVariant[];
  estimatedModelSpendUsd: number;
}

export interface StructuredLogEntry {
  severity: "DEBUG" | "INFO" | "WARNING" | "ERROR";
  message: string;
  eventId?: string;
  campaignId?: string;
  runId?: string;
  traceId?: string;
  stepId?: string;
  tool?: string;
  attempt?: number;
  model?: string;
  outcome?: string;
  metadata?: Record<string, unknown>;
}
