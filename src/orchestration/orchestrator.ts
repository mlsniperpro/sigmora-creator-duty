import type { AppConfig } from "../config.js";
import { canonicalJson, newId, sha256, stableId } from "../domain/ids.js";
import type {
  CampaignArtifact,
  CampaignRecord,
  CampaignStage,
  ChannelVariant,
  CreatorLiveEvent,
  ProcessResult,
  ProviderPublication,
  PublicationReceipt,
  StepRecord,
} from "../domain/types.js";
import type { Logger } from "../logging/logger.js";
import type { CampaignCritic, ModelAgent } from "../models/index.js";
import { ModelAgentError } from "../models/errors.js";
import type { MediaRenderer } from "../providers/media.js";
import { PublishError, type PublishRequest, type Publisher } from "../providers/publisher.js";
import type { SourceProvider } from "../providers/source.js";
import type { StateStore } from "../storage/index.js";
import { validateRelease } from "../tools/policy.js";
import { canTransition, transitionCampaign } from "./state-machine.js";

const EXECUTION_LEASE_TTL_MS = 10 * 60 * 1_000;
const MAX_PUBLISH_ATTEMPTS = 3;

export interface AdditionalMediaProvider {
  readonly name: string;
  generate(input: {
    campaign: CampaignRecord;
    event: CreatorLiveEvent;
    plan: NonNullable<CampaignRecord["plan"]>;
    promo: CampaignArtifact;
  }): Promise<CampaignArtifact[]>;
}

export interface OrchestratorDependencies {
  config: AppConfig;
  store: StateStore;
  source: SourceProvider;
  model: ModelAgent;
  media: MediaRenderer;
  publisher: Publisher;
  logger: Logger;
  critic?: CampaignCritic;
  additionalMedia?: AdditionalMediaProvider;
  now?: () => Date;
  nowMilliseconds?: () => number;
  retryDelay?: (attempt: number) => Promise<void>;
}

export class CampaignBusyError extends Error {
  public override readonly name = "CampaignBusyError";

  public constructor(public readonly campaignId: string) {
    super(`Campaign ${campaignId} already has an active execution lease.`);
  }
}

export class CreatorDutyOrchestrator {
  private readonly now: () => Date;
  private readonly nowMilliseconds: () => number;
  private readonly retryDelay: (attempt: number) => Promise<void>;

  public constructor(private readonly dependencies: OrchestratorDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.nowMilliseconds = dependencies.nowMilliseconds ?? (() => Date.now());
    this.retryDelay =
      dependencies.retryDelay ??
      ((attempt) => new Promise((resolve) => setTimeout(resolve, 150 * 2 ** (attempt - 1))));
  }

  public async process(event: CreatorLiveEvent): Promise<ProcessResult> {
    return event.eventType === "creator.live.started"
      ? this.processLiveStarted(event)
      : this.processLiveEnded(event);
  }

  private async processLiveStarted(event: CreatorLiveEvent): Promise<ProcessResult> {
    const initial = this.createCampaign(event);
    const claim = await this.dependencies.store.claimEvent(event, initial);
    const campaignId = claim.campaignId;

    if (claim.disposition === "duplicate_ignored") {
      const campaign = await this.requireCampaign(campaignId);
      await this.recordDuplicateGuard(campaign, event);
      return {
        eventId: event.eventId,
        campaignId,
        traceId: campaign.traceId,
        disposition: claim.disposition,
        stage: campaign.stage,
        outcome: "duplicate_ignored",
      };
    }

    const leaseOwner = newId("lease");
    const acquired = await this.dependencies.store.acquireCampaignLease(
      campaignId,
      leaseOwner,
      EXECUTION_LEASE_TTL_MS,
    );
    if (!acquired) throw new CampaignBusyError(campaignId);

    const workflowStartedAt = this.nowMilliseconds();
    try {
      return await this.runStartWorkflow(event, campaignId, claim.disposition, workflowStartedAt);
    } catch (error) {
      await this.markException(campaignId, error);
      throw error;
    } finally {
      await this.dependencies.store.releaseCampaignLease(campaignId, leaseOwner);
    }
  }

  private async runStartWorkflow(
    event: CreatorLiveEvent,
    campaignId: string,
    disposition: ProcessResult["disposition"],
    workflowStartedAt: number,
  ): Promise<ProcessResult> {
    const source = await this.runStep(campaignId, event, "load_live_source", 1, undefined, () =>
      this.dependencies.source.load(event),
    );

    let campaign = await this.requireCampaign(campaignId);
    if (!campaign.plan) {
      await this.setStage(campaignId, "planning");
      const result = await this.runStep(
        campaignId,
        event,
        "plan_campaign",
        1,
        this.dependencies.model.model,
        () =>
          this.dependencies.model.planCampaign({
            event,
            source,
            maxEstimatedModelSpendUsd: this.dependencies.config.maxModelSpendUsd,
          }),
      );
      campaign = await this.dependencies.store.updateCampaign(campaignId, (draft) => {
        draft.plan = result.value;
        draft.invocations.push(result.invocation);
        draft.primaryModel = result.invocation.modelVersion;
        draft.modelProvider = result.invocation.provider;
      });
      this.logModelEvidence(campaign, event, result.evidence, "plan_campaign");
    }

    campaign = await this.requireCampaign(campaignId);
    if (!findPromo(campaign)) {
      await this.setStage(campaignId, "producing");
      const plan = requirePlan(await this.requireCampaign(campaignId));
      const rendered = await this.runStep(
        campaignId,
        event,
        "render_promo",
        1,
        undefined,
        () => this.dependencies.media.renderPromo({ campaign: campaign, event, plan, source }),
      );
      campaign = await this.dependencies.store.updateCampaign(campaignId, (draft) => {
        draft.artifacts = upsertArtifacts(draft.artifacts, rendered);
      });
    }

    campaign = await this.requireCampaign(campaignId);
    if (this.dependencies.additionalMedia && !hasAdditionalMedia(campaign)) {
      const plan = requirePlan(campaign);
      const promo = requirePromo(campaign);
      const generated = await this.runStep(
        campaignId,
        event,
        "generate_additional_media",
        1,
        undefined,
        () => this.dependencies.additionalMedia!.generate({ campaign, event, plan, promo }),
      );
      campaign = await this.dependencies.store.updateCampaign(campaignId, (draft) => {
        draft.artifacts = upsertArtifacts(draft.artifacts, generated);
      });
    }

    campaign = await this.requireCampaign(campaignId);
    if (campaign.variants.length === 0) {
      if (campaign.stage === "planning") await this.setStage(campaignId, "producing");
      const plan = requirePlan(campaign);
      const result = await this.runStep(
        campaignId,
        event,
        "draft_channel_variants",
        1,
        this.dependencies.model.model,
        () =>
          this.dependencies.model.draftChannelVariants({
            event,
            source,
            plan,
            ctaUrl: "https://sigmora.org/",
          }),
      );
      const attributed = addChannelAttribution(result.value, campaignId);
      campaign = await this.dependencies.store.updateCampaign(campaignId, (draft) => {
        draft.variants = attributed;
        draft.invocations.push(result.invocation);
        draft.primaryModel = result.invocation.modelVersion;
      });
      this.logModelEvidence(campaign, event, result.evidence, "draft_channel_variants");
    }

    campaign = await this.requireCampaign(campaignId);
    if (this.dependencies.critic && !campaign.critic) {
      const plan = requirePlan(campaign);
      const result = await this.runStep(
        campaignId,
        event,
        "critique_with_gemma",
        1,
        this.dependencies.critic.model,
        () =>
          this.dependencies.critic!.critique({
            plan,
            variants: campaign.variants,
            policySummary:
              "Deterministic policy will independently enforce creator, destination, media, copy, link, quiet-hour, and spend limits.",
          }),
      );
      campaign = await this.dependencies.store.updateCampaign(campaignId, (draft) => {
        draft.critic = result.value;
        draft.invocations.push(result.invocation);
      });
      this.logModelEvidence(campaign, event, result.evidence, "critic");
    }

    campaign = await this.requireCampaign(campaignId);
    if (!campaign.validation) {
      await this.setStage(campaignId, "validating");
      campaign = await this.requireCampaign(campaignId);
      const plan = requirePlan(campaign);
      const promo = requirePromo(campaign);
      const policy = await this.runStep(
        campaignId,
        event,
        "validate_release",
        1,
        undefined,
        async () =>
          validateRelease({
            event,
            plan,
            promo,
            variants: campaign.variants,
            allowedCreatorId: this.dependencies.config.demoCreatorId,
            maxModelSpendUsd: this.dependencies.config.maxModelSpendUsd,
          }),
      );
      campaign = await this.dependencies.store.updateCampaign(campaignId, (draft) => {
        draft.validation = policy.validation;
      });
    }

    campaign = await this.requireCampaign(campaignId);
    if (!campaign.validation?.passed) {
      campaign = await this.setStage(campaignId, "blocked");
      campaign = await this.dependencies.store.updateCampaign(campaignId, (draft) => {
        draft.outcome = "policy_blocked";
      });
      return resultFor(event, campaign, disposition, "policy_blocked");
    }

    if (campaign.stage !== "publishing" && campaign.stage !== "verifying") {
      await this.setStage(campaignId, "publishing");
    }
    await this.publishInitialPass(event, campaignId);
    campaign = await this.requireCampaign(campaignId);
    if (campaign.stage === "publishing") await this.setStage(campaignId, "verifying");
    await this.verifyAndRecover(event, campaignId);

    campaign = await this.setStage(campaignId, "complete");
    campaign = await this.dependencies.store.updateCampaign(campaignId, (draft) => {
      draft.outcome = "autonomous_campaign_complete";
      draft.metrics.channelCount = draft.receipts.filter((receipt) => receipt.status === "verified").length;
      draft.metrics.duplicatePosts = 0;
      draft.metrics.elapsedMs = Math.max(0, this.nowMilliseconds() - workflowStartedAt);
    });
    return resultFor(event, campaign, disposition, "autonomous_campaign_complete");
  }

  private async publishInitialPass(event: CreatorLiveEvent, campaignId: string): Promise<void> {
    const campaign = await this.requireCampaign(campaignId);
    const validation = requireValidation(campaign);
    const promo = requirePromo(campaign);
    for (const variant of campaign.variants) {
      const existing = campaign.receipts.find((receipt) => receipt.channel === variant.channel);
      if (existing) continue;
      await this.attemptPublication(event, campaignId, variant, promo, validation.releaseHash, 1);
    }
  }

  private async verifyAndRecover(event: CreatorLiveEvent, campaignId: string): Promise<void> {
    const recoveryStarted = new Map<string, number>();
    const campaign = await this.requireCampaign(campaignId);
    for (const variant of campaign.variants) {
      let receipt = requireReceipt(await this.requireCampaign(campaignId), variant.channel);
      while (receipt.status !== "verified") {
        let publication = publicationFromReceipt(receipt);
        if (!publication) {
          publication = await this.runStep(
            campaignId,
            event,
            "lookup_publication",
            receipt.attempt,
            undefined,
            () => this.dependencies.publisher.lookup(receipt.idempotencyKey),
            variant.channel,
          );
        }

        if (publication) {
          const verified = await this.runStep(
            campaignId,
            event,
            "verify_receipt",
            receipt.attempt,
            undefined,
            () => this.dependencies.publisher.verify(publication!),
            variant.channel,
          );
          if (verified) {
            const { errorCode: _errorCode, errorMessage: _errorMessage, ...receiptWithoutError } = receipt;
            receipt = await this.saveReceipt(campaignId, {
              ...receiptWithoutError,
              providerPostId: publication.providerPostId,
              providerUrl: publication.providerUrl,
              committedAt: publication.committedAt,
              verifiedAt: this.now().toISOString(),
              status: "verified",
            });
            const started = recoveryStarted.get(variant.channel);
            if (started !== undefined) {
              await this.dependencies.store.updateCampaign(campaignId, (draft) => {
                draft.metrics.recoveryMs = Math.max(0, this.nowMilliseconds() - started);
              });
            }
            continue;
          }
        }

        if (receipt.status === "failed") {
          throw new Error(`Terminal publication failure for ${variant.channel}: ${receipt.errorCode ?? "unknown"}.`);
        }
        if (receipt.attempt >= MAX_PUBLISH_ATTEMPTS) {
          await this.saveReceipt(campaignId, {
            ...receipt,
            status: "failed",
            errorCode: "RETRY_EXHAUSTED",
            errorMessage: `No verified receipt after ${MAX_PUBLISH_ATTEMPTS} attempts.`,
          });
          throw new Error(`Publication retry exhausted for ${variant.channel}.`);
        }

        recoveryStarted.set(variant.channel, recoveryStarted.get(variant.channel) ?? this.nowMilliseconds());
        await this.setStage(campaignId, "publishing");
        await this.retryDelay(receipt.attempt);
        const nextAttempt = receipt.attempt + 1;
        await this.dependencies.store.updateCampaign(campaignId, (draft) => {
          draft.metrics.retryCount += 1;
        });
        await this.attemptPublication(
          event,
          campaignId,
          variant,
          requirePromo(await this.requireCampaign(campaignId)),
          requireValidation(await this.requireCampaign(campaignId)).releaseHash,
          nextAttempt,
        );
        await this.setStage(campaignId, "verifying");
        receipt = requireReceipt(await this.requireCampaign(campaignId), variant.channel);
      }
    }
  }

  private async attemptPublication(
    event: CreatorLiveEvent,
    campaignId: string,
    variant: ChannelVariant,
    artifact: CampaignArtifact,
    releaseHash: string,
    attempt: number,
  ): Promise<void> {
    const idempotencyKey = stableId("publish", `${releaseHash}:${variant.channel}`, 40);
    const pending: PublicationReceipt = {
      receiptId: stableId("receipt", `${campaignId}:${variant.channel}`, 32),
      campaignId,
      channel: variant.channel,
      idempotencyKey,
      status: "pending",
      attempt,
    };
    await this.saveReceipt(campaignId, pending);

    const request: PublishRequest = {
      campaignId,
      channel: variant.channel,
      variant,
      artifact,
      releaseHash,
      idempotencyKey,
    };
    try {
      const publication = await this.runStep(
        campaignId,
        event,
        "publish_release",
        attempt,
        undefined,
        () => this.dependencies.publisher.publish(request),
        variant.channel,
      );
      await this.saveReceipt(campaignId, {
        ...pending,
        providerPostId: publication.providerPostId,
        providerUrl: publication.providerUrl,
        committedAt: publication.committedAt,
      });
    } catch (error) {
      const publishError = normalizePublishError(error);
      await this.saveReceipt(campaignId, {
        ...pending,
        status: publishError.retryable ? "retrying" : "failed",
        errorCode: publishError.code,
        errorMessage: publishError.message,
      });
    }
  }

  private async processLiveEnded(event: CreatorLiveEvent): Promise<ProcessResult> {
    const existing = await this.dependencies.store.getCampaignByStream(event.stream.streamId);
    if (!existing) throw new Error(`No campaign exists for ended stream ${event.stream.streamId}.`);
    const claim = await this.dependencies.store.claimEvent(event, existing);
    if (claim.disposition === "duplicate_ignored") {
      return resultFor(event, existing, claim.disposition, "duplicate_ignored");
    }

    const leaseOwner = newId("lease");
    const acquired = await this.dependencies.store.acquireCampaignLease(
      existing.campaignId,
      leaseOwner,
      EXECUTION_LEASE_TTL_MS,
    );
    if (!acquired) throw new CampaignBusyError(existing.campaignId);
    try {
      let campaign = await this.requireCampaign(existing.campaignId);
      if (campaign.stage !== "recapping") await this.setStage(campaign.campaignId, "recapping");
      const source = await this.runStep(
        campaign.campaignId,
        event,
        "load_live_source",
        1,
        undefined,
        () => this.dependencies.source.load(event),
        "recap",
      );
      campaign = await this.requireCampaign(campaign.campaignId);
      if (!campaign.recap) {
        const result = await this.runStep(
          campaign.campaignId,
          event,
          "prepare_recap",
          1,
          this.dependencies.model.model,
          () =>
            this.dependencies.model.prepareRecap({
              event,
              source,
              ...(campaign.plan === undefined ? {} : { plan: campaign.plan }),
              variants: campaign.variants,
            }),
        );
        campaign = await this.dependencies.store.updateCampaign(campaign.campaignId, (draft) => {
          draft.recap = result.value;
          draft.invocations.push(result.invocation);
        });
        this.logModelEvidence(campaign, event, result.evidence, "prepare_recap");
      }
      campaign = await this.setStage(campaign.campaignId, "closed");
      campaign = await this.dependencies.store.updateCampaign(campaign.campaignId, (draft) => {
        draft.outcome = "post_live_recap_complete";
      });
      return resultFor(event, campaign, claim.disposition, "post_live_recap_complete");
    } catch (error) {
      await this.markException(existing.campaignId, error);
      throw error;
    } finally {
      await this.dependencies.store.releaseCampaignLease(existing.campaignId, leaseOwner);
    }
  }

  private createCampaign(event: CreatorLiveEvent): CampaignRecord {
    const timestamp = this.now().toISOString();
    return {
      campaignId: stableId("cmp", event.eventId),
      eventId: event.eventId,
      creatorId: event.creatorId,
      streamId: event.stream.streamId,
      traceId: sha256(`trace:${event.eventId}`).slice(0, 32),
      runId: newId("run"),
      stage: "received",
      createdAt: timestamp,
      updatedAt: timestamp,
      modelProvider: this.dependencies.model.provider,
      primaryModel: this.dependencies.model.model,
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

  private async setStage(campaignId: string, stage: CampaignStage): Promise<CampaignRecord> {
    return this.dependencies.store.updateCampaign(campaignId, (draft) => {
      if (draft.stage === stage) return;
      return transitionCampaign(draft, stage, this.now());
    });
  }

  private async runStep<T>(
    campaignId: string,
    event: CreatorLiveEvent,
    tool: string,
    attempt: number,
    model: string | undefined,
    action: () => Promise<T>,
    scope = "campaign",
  ): Promise<T> {
    const stepId = stableId("step", `${campaignId}:${tool}:${scope}:${attempt}`, 24);
    const startedAt = this.now().toISOString();
    await this.upsertStep(campaignId, {
      stepId,
      tool,
      status: "running",
      attempt,
      startedAt,
      ...(model === undefined ? {} : { model }),
      metadata: { scope },
    });
    const campaign = await this.requireCampaign(campaignId);
    this.dependencies.logger.log({
      severity: "INFO",
      message: `${tool} started`,
      eventId: event.eventId,
      campaignId,
      runId: campaign.runId,
      traceId: campaign.traceId,
      stepId,
      tool,
      attempt,
      ...(model === undefined ? {} : { model }),
      outcome: "started",
    });

    try {
      const result = await action();
      await this.upsertStep(campaignId, {
        stepId,
        tool,
        status: "succeeded",
        attempt,
        startedAt,
        completedAt: this.now().toISOString(),
        outcome: "succeeded",
        ...(model === undefined ? {} : { model }),
        metadata: { scope },
      });
      this.dependencies.logger.log({
        severity: "INFO",
        message: `${tool} succeeded`,
        eventId: event.eventId,
        campaignId,
        runId: campaign.runId,
        traceId: campaign.traceId,
        stepId,
        tool,
        attempt,
        ...(model === undefined ? {} : { model }),
        outcome: "succeeded",
      });
      return result;
    } catch (error) {
      const message = safeErrorMessage(error);
      const diagnostic = safeErrorDiagnostic(error);
      await this.upsertStep(campaignId, {
        stepId,
        tool,
        status: "failed",
        attempt,
        startedAt,
        completedAt: this.now().toISOString(),
        outcome: "failed",
        error: message,
        ...(model === undefined ? {} : { model }),
        metadata: { scope, ...diagnostic },
      });
      this.dependencies.logger.log({
        severity: "WARNING",
        message: `${tool} failed`,
        eventId: event.eventId,
        campaignId,
        runId: campaign.runId,
        traceId: campaign.traceId,
        stepId,
        tool,
        attempt,
        ...(model === undefined ? {} : { model }),
        outcome: "failed",
        metadata: { error: message, scope, ...diagnostic },
      });
      throw error;
    }
  }

  private async upsertStep(campaignId: string, step: StepRecord): Promise<void> {
    await this.dependencies.store.updateCampaign(campaignId, (draft) => {
      const index = draft.steps.findIndex((candidate) => candidate.stepId === step.stepId);
      if (index === -1) draft.steps.push(step);
      else draft.steps[index] = step;
    });
  }

  private async saveReceipt(
    campaignId: string,
    receipt: PublicationReceipt,
  ): Promise<PublicationReceipt> {
    const campaign = await this.dependencies.store.updateCampaign(campaignId, (draft) => {
      const index = draft.receipts.findIndex((candidate) => candidate.channel === receipt.channel);
      const sanitized = withoutUndefined(receipt);
      if (index === -1) draft.receipts.push(sanitized);
      else draft.receipts[index] = sanitized;
    });
    return requireReceipt(campaign, receipt.channel);
  }

  private async recordDuplicateGuard(campaign: CampaignRecord, event: CreatorLiveEvent): Promise<void> {
    const attempt = campaign.steps.filter((step) => step.tool === "duplicate_guard").length + 1;
    await this.runStep(
      campaign.campaignId,
      event,
      "duplicate_guard",
      attempt,
      undefined,
      async () => "duplicate_ignored",
      event.eventId,
    );
    await this.dependencies.store.updateCampaign(campaign.campaignId, (draft) => {
      draft.outcome = "duplicate_ignored";
      draft.metrics.duplicatePosts = 0;
    });
  }

  private async markException(campaignId: string, error: unknown): Promise<void> {
    try {
      await this.dependencies.store.updateCampaign(campaignId, (draft) => {
        if (draft.stage !== "blocked" && draft.stage !== "closed" && canTransition(draft.stage, "exception")) {
          const transitioned = transitionCampaign(draft, "exception", this.now());
          transitioned.outcome = `exception:${safeErrorMessage(error)}`;
          return transitioned;
        }
        return draft;
      });
    } catch {
      // Preserve the original workflow failure; logging still carries the trace.
    }
  }

  private async requireCampaign(campaignId: string): Promise<CampaignRecord> {
    const campaign = await this.dependencies.store.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}.`);
    return campaign;
  }

  private logModelEvidence(
    campaign: CampaignRecord,
    event: CreatorLiveEvent,
    evidence: {
      sdk: string;
      provider: string;
      requestedModel: string;
      resolvedModel: string;
      responseId: string;
      finishReason: string;
    },
    tool: string,
  ): void {
    this.dependencies.logger.log({
      severity: "INFO",
      message: `${tool} model evidence`,
      eventId: event.eventId,
      campaignId: campaign.campaignId,
      runId: campaign.runId,
      traceId: campaign.traceId,
      tool,
      model: evidence.resolvedModel,
      outcome: evidence.finishReason,
      metadata: {
        sdk: evidence.sdk,
        provider: evidence.provider,
        requestedModel: evidence.requestedModel,
        responseId: evidence.responseId,
      },
    });
  }
}

function requirePlan(campaign: CampaignRecord): NonNullable<CampaignRecord["plan"]> {
  if (!campaign.plan) throw new Error(`Campaign ${campaign.campaignId} has no validated plan.`);
  return campaign.plan;
}

function findPromo(campaign: CampaignRecord): CampaignArtifact | undefined {
  return [...campaign.artifacts].reverse().find((artifact) => artifact.kind === "promo_video");
}

function requirePromo(campaign: CampaignRecord): CampaignArtifact {
  const promo = findPromo(campaign);
  if (!promo) throw new Error(`Campaign ${campaign.campaignId} has no promo video.`);
  return promo;
}

function requireValidation(campaign: CampaignRecord): NonNullable<CampaignRecord["validation"]> {
  if (!campaign.validation?.passed) {
    throw new Error(`Campaign ${campaign.campaignId} does not have a passing validation record.`);
  }
  return campaign.validation;
}

function requireReceipt(campaign: CampaignRecord, channel: ChannelVariant["channel"]): PublicationReceipt {
  const receipt = campaign.receipts.find((candidate) => candidate.channel === channel);
  if (!receipt) throw new Error(`Campaign ${campaign.campaignId} has no ${channel} receipt.`);
  return receipt;
}

function publicationFromReceipt(receipt: PublicationReceipt): ProviderPublication | undefined {
  if (!receipt.providerPostId || !receipt.providerUrl || !receipt.committedAt) return undefined;
  return {
    idempotencyKey: receipt.idempotencyKey,
    channel: receipt.channel,
    providerPostId: receipt.providerPostId,
    providerUrl: receipt.providerUrl,
    committedAt: receipt.committedAt,
  };
}

function upsertArtifacts(
  existing: CampaignArtifact[],
  incoming: CampaignArtifact[],
): CampaignArtifact[] {
  const byId = new Map(existing.map((artifact) => [artifact.artifactId, artifact]));
  for (const artifact of incoming) byId.set(artifact.artifactId, artifact);
  return [...byId.values()];
}

function hasAdditionalMedia(campaign: CampaignRecord): boolean {
  return campaign.artifacts.some(
    (artifact) => artifact.kind === "veo_broll" || artifact.kind === "lyria_music",
  );
}

function addChannelAttribution(variants: ChannelVariant[], campaignId: string): ChannelVariant[] {
  return variants.map((variant) => {
    const url = new URL(variant.ctaUrl);
    url.searchParams.set("utm_source", variant.channel);
    url.searchParams.set("utm_medium", "agentic_campaign");
    url.searchParams.set("utm_campaign", "all_things_agentic_2026");
    url.searchParams.set("utm_content", campaignId);
    return { ...variant, ctaUrl: url.toString() };
  });
}

function normalizePublishError(error: unknown): PublishError {
  if (error instanceof PublishError) return error;
  return new PublishError(safeErrorMessage(error), "UNEXPECTED_PUBLISH_ERROR", false, true, {
    cause: error,
  });
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

function safeErrorDiagnostic(error: unknown): Record<string, unknown> {
  if (!(error instanceof ModelAgentError)) return {};
  return {
    errorCode: error.code,
    ...(error.issues.length === 0
      ? {}
      : { validationIssues: error.issues.slice(0, 8).map((issue) => issue.slice(0, 300)) }),
  };
}

function withoutUndefined(receipt: PublicationReceipt): PublicationReceipt {
  return Object.fromEntries(
    Object.entries(receipt).filter(([, value]) => value !== undefined),
  ) as unknown as PublicationReceipt;
}

function resultFor(
  event: CreatorLiveEvent,
  campaign: CampaignRecord,
  disposition: ProcessResult["disposition"],
  outcome: string,
): ProcessResult {
  return {
    eventId: event.eventId,
    campaignId: campaign.campaignId,
    traceId: campaign.traceId,
    disposition,
    stage: campaign.stage,
    outcome,
  };
}

export function campaignReleaseFingerprint(campaign: CampaignRecord): string | undefined {
  if (!campaign.validation) return undefined;
  return sha256(
    canonicalJson({
      campaignId: campaign.campaignId,
      validation: campaign.validation,
      artifacts: campaign.artifacts.map(({ artifactId, sha256: digest }) => ({ artifactId, sha256: digest })),
      variants: campaign.variants,
    }),
  );
}
