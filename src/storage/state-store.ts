import type {
  CampaignRecord,
  CampaignStage,
  CreatorLiveEvent,
  EventClaim,
  ProviderPublication,
} from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/ids.js";

export type CampaignUpdater = (campaign: CampaignRecord) => CampaignRecord | void;

export interface DemoStartPolicy {
  /** Maximum successful demo starts in one UTC calendar day. */
  dailyLimit: number;
  /** Minimum elapsed time between successful starts. */
  cooldownSeconds: number;
}

export interface DemoStartDecision {
  allowed: boolean;
  /** Whole seconds until another reservation can be attempted successfully. */
  retryAfterSeconds: number;
  /** Unconsumed starts in the current UTC day after this decision. */
  remaining: number;
}

export interface DemoStartQuotaState {
  utcDate: string;
  startedCount: number;
  lastStartedAt: string;
}

export interface DemoStartReservation {
  decision: DemoStartDecision;
  /** Present only when the reservation was allowed and must be committed. */
  state?: DemoStartQuotaState;
}

/**
 * Durable state boundary for the Creator Duty workflow.
 *
 * `claimEvent` is deliberately stronger than a separate "has event" check and
 * campaign insert: implementations must atomically create both records so a
 * concurrent Pub/Sub redelivery can never create a second campaign. A new
 * start event creates its supplied campaign; a new end event can claim the
 * existing stream campaign supplied by the caller. Replaying the exact payload
 * resumes non-complete work, while complete/closed work is ignored. Reusing an
 * event ID for a different canonical payload is an integrity error.
 *
 * Campaign deletion is intentionally absent. Event claims and campaign records
 * are audit evidence and must remain available for replay protection.
 */
export interface StateStore {
  /** Atomically reserves capacity from the process-independent global demo-start quota. */
  reserveDemoStart(policy: DemoStartPolicy): Promise<DemoStartDecision>;

  claimEvent(event: CreatorLiveEvent, initialCampaign: CampaignRecord): Promise<EventClaim>;

  createCampaign(campaign: CampaignRecord): Promise<CampaignRecord>;
  getCampaign(campaignId: string): Promise<CampaignRecord | null>;
  updateCampaign(campaignId: string, updater: CampaignUpdater): Promise<CampaignRecord>;

  getCampaignByStream(streamId: string): Promise<CampaignRecord | null>;
  getLatestCampaign(): Promise<CampaignRecord | null>;
  listCampaigns(limit?: number): Promise<CampaignRecord[]>;

  /** Compare-and-set lease that prevents concurrent Pub/Sub deliveries from running one campaign twice. */
  acquireCampaignLease(campaignId: string, ownerId: string, ttlMs: number): Promise<boolean>;
  releaseCampaignLease(campaignId: string, ownerId: string): Promise<void>;

  getProviderPublication(idempotencyKey: string): Promise<ProviderPublication | null>;
  recordProviderPublication(publication: ProviderPublication): Promise<ProviderPublication>;
}

export type StorageClock = () => string;

export const defaultStorageClock: StorageClock = () => new Date().toISOString();

const MAX_DAILY_DEMO_STARTS = 1_000_000;
const MAX_DEMO_COOLDOWN_SECONDS = 86_400;
const MILLISECONDS_PER_SECOND = 1_000;
const MILLISECONDS_PER_DAY = 86_400_000;

export class CampaignAlreadyExistsError extends Error {
  constructor(campaignId: string) {
    super(`Campaign already exists: ${campaignId}`);
    this.name = "CampaignAlreadyExistsError";
  }
}

export class CampaignNotFoundError extends Error {
  constructor(campaignId: string) {
    super(`Campaign not found: ${campaignId}`);
    this.name = "CampaignNotFoundError";
  }
}

export class StorageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageIntegrityError";
  }
}

export class ProviderPublicationConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`Provider publication idempotency key was reused with different data: ${idempotencyKey}`);
    this.name = "ProviderPublicationConflictError";
  }
}

/**
 * Pure quota calculation shared by process-local and durable implementations.
 * A returned state represents an allowed reservation and must be committed
 * atomically with the read of `existing`.
 */
export function calculateDemoStartReservation(
  existing: DemoStartQuotaState | undefined,
  policy: DemoStartPolicy,
  now: string,
): DemoStartReservation {
  validateDemoStartPolicy(policy);
  const { milliseconds: nowMilliseconds, iso: nowIso, utcDate } = normalizeStorageTime(now);
  validateDemoStartQuotaState(existing);

  const startedToday = existing?.utcDate === utcDate ? existing.startedCount : 0;
  const remainingBeforeReservation = Math.max(0, policy.dailyLimit - startedToday);
  const nextUtcDayMilliseconds =
    Date.parse(`${utcDate}T00:00:00.000Z`) + MILLISECONDS_PER_DAY;
  const dailyRetryMilliseconds = startedToday >= policy.dailyLimit
    ? nextUtcDayMilliseconds
    : nowMilliseconds;
  const lastStartedMilliseconds = existing === undefined
    ? Number.NEGATIVE_INFINITY
    : Date.parse(existing.lastStartedAt);
  const cooldownRetryMilliseconds =
    lastStartedMilliseconds + policy.cooldownSeconds * MILLISECONDS_PER_SECOND;
  const retryAtMilliseconds = Math.max(dailyRetryMilliseconds, cooldownRetryMilliseconds);

  if (retryAtMilliseconds > nowMilliseconds) {
    return {
      decision: {
        allowed: false,
        retryAfterSeconds: Math.ceil(
          (retryAtMilliseconds - nowMilliseconds) / MILLISECONDS_PER_SECOND,
        ),
        remaining: remainingBeforeReservation,
      },
    };
  }

  const startedCount = startedToday + 1;
  return {
    decision: {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: policy.dailyLimit - startedCount,
    },
    state: {
      utcDate,
      startedCount,
      lastStartedAt: nowIso,
    },
  };
}

export function validateDemoStartPolicy(policy: DemoStartPolicy): void {
  if (
    !Number.isSafeInteger(policy.dailyLimit) ||
    policy.dailyLimit < 1 ||
    policy.dailyLimit > MAX_DAILY_DEMO_STARTS
  ) {
    throw new RangeError(
      `Demo daily limit must be an integer between 1 and ${MAX_DAILY_DEMO_STARTS}.`,
    );
  }
  if (
    !Number.isSafeInteger(policy.cooldownSeconds) ||
    policy.cooldownSeconds < 0 ||
    policy.cooldownSeconds > MAX_DEMO_COOLDOWN_SECONDS
  ) {
    throw new RangeError(
      `Demo cooldown must be an integer between 0 and ${MAX_DEMO_COOLDOWN_SECONDS} seconds.`,
    );
  }
}

function normalizeStorageTime(value: string): {
  milliseconds: number;
  iso: string;
  utcDate: string;
} {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new StorageIntegrityError(`Storage clock returned an invalid timestamp: ${value}.`);
  }
  const iso = new Date(milliseconds).toISOString();
  return { milliseconds, iso, utcDate: iso.slice(0, 10) };
}

function validateDemoStartQuotaState(
  state: DemoStartQuotaState | undefined,
): void {
  if (state === undefined) {
    return;
  }
  const lastStartedMilliseconds = Date.parse(state.lastStartedAt);
  const canonicalDate = Number.isFinite(lastStartedMilliseconds)
    ? new Date(lastStartedMilliseconds).toISOString().slice(0, 10)
    : undefined;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(state.utcDate) ||
    canonicalDate !== state.utcDate ||
    !Number.isSafeInteger(state.startedCount) ||
    state.startedCount < 1
  ) {
    throw new StorageIntegrityError("Malformed demo-start quota state.");
  }
}

/** A complete campaign and its post-live closed form are final for event replay. */
export function isReplayComplete(stage: CampaignStage): boolean {
  return stage === "complete" || stage === "closed";
}

export function cloneStorageValue<T>(value: T): T {
  return structuredClone(value);
}

export function eventPayloadFingerprint(event: CreatorLiveEvent): string {
  return sha256(canonicalJson(event));
}

export function validateClaimInput(
  event: CreatorLiveEvent,
  campaign: CampaignRecord,
): void {
  if (campaign.creatorId !== event.creatorId) {
    throw new StorageIntegrityError(
      `Campaign ${campaign.campaignId} creator does not match event ${event.eventId}.`,
    );
  }
  if (campaign.streamId !== event.stream.streamId) {
    throw new StorageIntegrityError(
      `Campaign ${campaign.campaignId} stream does not match event ${event.eventId}.`,
    );
  }
  if (event.eventType === "creator.live.started" && campaign.eventId !== event.eventId) {
    throw new StorageIntegrityError(
      `Campaign ${campaign.campaignId} start event does not match event ${event.eventId}.`,
    );
  }
}

export function validateExistingCampaign(
  expected: CampaignRecord,
  existing: CampaignRecord,
): void {
  if (
    expected.campaignId !== existing.campaignId ||
    expected.creatorId !== existing.creatorId ||
    expected.streamId !== existing.streamId
  ) {
    throw new StorageIntegrityError(
      `Campaign identity conflict for ${expected.campaignId}.`,
    );
  }
}

export function applyCampaignUpdate(
  existing: CampaignRecord,
  updater: CampaignUpdater,
  updatedAt: string,
): CampaignRecord {
  const draft = cloneStorageValue(existing);
  const replacement = updater(draft);
  const updated = replacement === undefined ? draft : cloneStorageValue(replacement);

  if (updated.campaignId !== existing.campaignId) {
    throw new StorageIntegrityError("A campaign update cannot change campaignId.");
  }
  if (
    updated.eventId !== existing.eventId ||
    updated.creatorId !== existing.creatorId ||
    updated.streamId !== existing.streamId
  ) {
    throw new StorageIntegrityError("A campaign update cannot change event, creator, or stream identity.");
  }

  updated.updatedAt = updatedAt;
  return updated;
}

export function normalizeListLimit(limit: number | undefined): number {
  const normalized = limit ?? 50;
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 500) {
    throw new RangeError("Campaign list limit must be an integer between 0 and 500.");
  }
  return normalized;
}

export function leaseExpiration(now: string, ttlMs: number): string {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 3_600_000) {
    throw new RangeError("Campaign lease TTL must be an integer between 1 second and 1 hour.");
  }
  const milliseconds = Date.parse(now);
  if (!Number.isFinite(milliseconds)) {
    throw new StorageIntegrityError(`Storage clock returned an invalid timestamp: ${now}.`);
  }
  return new Date(milliseconds + ttlMs).toISOString();
}

export function leaseIsActive(
  lease: CampaignRecord["executionLease"],
  now: string,
): boolean {
  return lease !== undefined && Date.parse(lease.expiresAt) > Date.parse(now);
}

export function compareCampaignsNewestFirst(
  left: CampaignRecord,
  right: CampaignRecord,
): number {
  const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
  return byCreatedAt === 0 ? right.campaignId.localeCompare(left.campaignId) : byCreatedAt;
}

export function publicationsMatch(
  left: ProviderPublication,
  right: ProviderPublication,
): boolean {
  return (
    left.idempotencyKey === right.idempotencyKey &&
    left.channel === right.channel &&
    left.providerPostId === right.providerPostId &&
    left.providerUrl === right.providerUrl &&
    left.committedAt === right.committedAt
  );
}
