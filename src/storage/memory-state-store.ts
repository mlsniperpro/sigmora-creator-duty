import type {
  CampaignRecord,
  CreatorLiveEvent,
  EventClaim,
  ProviderPublication,
} from "../domain/types.js";
import {
  CampaignAlreadyExistsError,
  CampaignNotFoundError,
  ProviderPublicationConflictError,
  StorageIntegrityError,
  applyCampaignUpdate,
  calculateDemoStartReservation,
  cloneStorageValue,
  compareCampaignsNewestFirst,
  defaultStorageClock,
  eventPayloadFingerprint,
  isReplayComplete,
  leaseExpiration,
  leaseIsActive,
  normalizeListLimit,
  publicationsMatch,
  validateClaimInput,
  validateExistingCampaign,
  type CampaignUpdater,
  type DemoStartDecision,
  type DemoStartPolicy,
  type DemoStartQuotaState,
  type StateStore,
  type StorageClock,
} from "./state-store.js";

interface StoredEventClaim {
  eventId: string;
  campaignId: string;
  claimedAt: string;
  eventType: CreatorLiveEvent["eventType"];
  payloadFingerprint: string;
}

/** Small FIFO mutex used to make compound Map operations genuinely atomic. */
class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = (): void => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export interface MemoryStateStoreOptions {
  now?: StorageClock;
}

/**
 * Process-local store for the deterministic demo and unit tests.
 *
 * Every read and write crosses a clone boundary. A caller can therefore mutate
 * an input or returned record without silently mutating persisted workflow
 * state. All compound operations are serialized through one mutex.
 */
export class MemoryStateStore implements StateStore {
  private readonly campaigns = new Map<string, CampaignRecord>();
  private readonly eventClaims = new Map<string, StoredEventClaim>();
  private readonly streamCampaigns = new Map<string, string>();
  private readonly publications = new Map<string, ProviderPublication>();
  private demoStartQuota: DemoStartQuotaState | undefined;
  private readonly mutex = new AsyncMutex();
  private readonly now: StorageClock;

  constructor(options: MemoryStateStoreOptions = {}) {
    this.now = options.now ?? defaultStorageClock;
  }

  async reserveDemoStart(policy: DemoStartPolicy): Promise<DemoStartDecision> {
    return this.mutex.runExclusive(() => {
      const reservation = calculateDemoStartReservation(
        this.demoStartQuota,
        policy,
        this.now(),
      );
      if (reservation.state !== undefined) {
        this.demoStartQuota = cloneStorageValue(reservation.state);
      }
      return cloneStorageValue(reservation.decision);
    });
  }

  async claimEvent(
    event: CreatorLiveEvent,
    initialCampaign: CampaignRecord,
  ): Promise<EventClaim> {
    validateClaimInput(event, initialCampaign);
    const payloadFingerprint = eventPayloadFingerprint(event);

    return this.mutex.runExclusive(() => {
      const existingClaim = this.eventClaims.get(event.eventId);
      if (existingClaim) {
        if (existingClaim.payloadFingerprint !== payloadFingerprint) {
          throw new StorageIntegrityError(
            `Event ID ${event.eventId} was replayed with a different payload.`,
          );
        }
        const campaign = this.campaigns.get(existingClaim.campaignId);
        if (!campaign) {
          throw new StorageIntegrityError(
            `Event ${event.eventId} references missing campaign ${existingClaim.campaignId}.`,
          );
        }
        return eventClaimResult(
          existingClaim,
          isReplayComplete(campaign.stage) ? "duplicate_ignored" : "resumed",
        );
      }

      const existingCampaign = this.campaigns.get(initialCampaign.campaignId);
      const campaignForIndex = existingCampaign ?? initialCampaign;
      if (existingCampaign) {
        validateExistingCampaign(initialCampaign, existingCampaign);
      } else {
        this.campaigns.set(initialCampaign.campaignId, cloneStorageValue(initialCampaign));
      }
      this.updateStreamIndex(campaignForIndex);

      const storedClaim: StoredEventClaim = {
        eventId: event.eventId,
        campaignId: initialCampaign.campaignId,
        claimedAt: this.now(),
        eventType: event.eventType,
        payloadFingerprint,
      };
      this.eventClaims.set(event.eventId, storedClaim);
      return eventClaimResult(storedClaim, "claimed");
    });
  }

  async createCampaign(campaign: CampaignRecord): Promise<CampaignRecord> {
    return this.mutex.runExclusive(() => {
      if (this.campaigns.has(campaign.campaignId)) {
        throw new CampaignAlreadyExistsError(campaign.campaignId);
      }
      const stored = cloneStorageValue(campaign);
      this.campaigns.set(campaign.campaignId, stored);
      this.updateStreamIndex(stored);
      return cloneStorageValue(stored);
    });
  }

  async getCampaign(campaignId: string): Promise<CampaignRecord | null> {
    return this.mutex.runExclusive(() => {
      const campaign = this.campaigns.get(campaignId);
      return campaign ? cloneStorageValue(campaign) : null;
    });
  }

  async updateCampaign(
    campaignId: string,
    updater: CampaignUpdater,
  ): Promise<CampaignRecord> {
    return this.mutex.runExclusive(() => {
      const existing = this.campaigns.get(campaignId);
      if (!existing) {
        throw new CampaignNotFoundError(campaignId);
      }
      const updated = applyCampaignUpdate(existing, updater, this.now());
      this.campaigns.set(campaignId, cloneStorageValue(updated));
      return cloneStorageValue(updated);
    });
  }

  async getCampaignByStream(streamId: string): Promise<CampaignRecord | null> {
    return this.mutex.runExclusive(() => {
      const campaignId = this.streamCampaigns.get(streamId);
      const campaign = campaignId ? this.campaigns.get(campaignId) : undefined;
      if (campaignId && !campaign) {
        throw new StorageIntegrityError(
          `Stream ${streamId} references missing campaign ${campaignId}.`,
        );
      }
      return campaign ? cloneStorageValue(campaign) : null;
    });
  }

  async getLatestCampaign(): Promise<CampaignRecord | null> {
    return this.mutex.runExclusive(() => {
      const campaign = [...this.campaigns.values()].sort(compareCampaignsNewestFirst)[0];
      return campaign ? cloneStorageValue(campaign) : null;
    });
  }

  async listCampaigns(limit?: number): Promise<CampaignRecord[]> {
    const normalizedLimit = normalizeListLimit(limit);
    if (normalizedLimit === 0) {
      return [];
    }
    return this.mutex.runExclusive(() =>
      [...this.campaigns.values()]
        .sort(compareCampaignsNewestFirst)
        .slice(0, normalizedLimit)
        .map(cloneStorageValue),
    );
  }

  async acquireCampaignLease(campaignId: string, ownerId: string, ttlMs: number): Promise<boolean> {
    if (!ownerId.trim()) throw new TypeError("Campaign lease ownerId is required.");
    return this.mutex.runExclusive(() => {
      const campaign = this.campaigns.get(campaignId);
      if (!campaign) throw new CampaignNotFoundError(campaignId);
      const now = this.now();
      if (
        leaseIsActive(campaign.executionLease, now) &&
        campaign.executionLease?.ownerId !== ownerId
      ) {
        return false;
      }
      const updated = cloneStorageValue(campaign);
      updated.executionLease = {
        ownerId,
        acquiredAt: now,
        expiresAt: leaseExpiration(now, ttlMs),
      };
      updated.updatedAt = now;
      this.campaigns.set(campaignId, updated);
      return true;
    });
  }

  async releaseCampaignLease(campaignId: string, ownerId: string): Promise<void> {
    await this.mutex.runExclusive(() => {
      const campaign = this.campaigns.get(campaignId);
      if (!campaign) throw new CampaignNotFoundError(campaignId);
      if (campaign.executionLease?.ownerId !== ownerId) return;
      const updated = cloneStorageValue(campaign);
      delete updated.executionLease;
      updated.updatedAt = this.now();
      this.campaigns.set(campaignId, updated);
    });
  }

  async getProviderPublication(idempotencyKey: string): Promise<ProviderPublication | null> {
    return this.mutex.runExclusive(() => {
      const publication = this.publications.get(idempotencyKey);
      return publication ? cloneStorageValue(publication) : null;
    });
  }

  async recordProviderPublication(
    publication: ProviderPublication,
  ): Promise<ProviderPublication> {
    return this.mutex.runExclusive(() => {
      const existing = this.publications.get(publication.idempotencyKey);
      if (existing) {
        if (!publicationsMatch(existing, publication)) {
          throw new ProviderPublicationConflictError(publication.idempotencyKey);
        }
        return cloneStorageValue(existing);
      }

      const stored = cloneStorageValue(publication);
      this.publications.set(publication.idempotencyKey, stored);
      return cloneStorageValue(stored);
    });
  }

  private updateStreamIndex(candidate: CampaignRecord): void {
    const currentId = this.streamCampaigns.get(candidate.streamId);
    const current = currentId ? this.campaigns.get(currentId) : undefined;
    if (!current || compareCampaignsNewestFirst(candidate, current) < 0) {
      this.streamCampaigns.set(candidate.streamId, candidate.campaignId);
    }
  }
}

function eventClaimResult(
  stored: StoredEventClaim,
  disposition: EventClaim["disposition"],
): EventClaim {
  return cloneStorageValue({
    eventId: stored.eventId,
    campaignId: stored.campaignId,
    claimedAt: stored.claimedAt,
    eventType: stored.eventType,
    disposition,
  });
}
