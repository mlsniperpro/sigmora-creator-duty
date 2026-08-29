import {
  Firestore,
  type DocumentData,
  type DocumentSnapshot,
} from "@google-cloud/firestore";

import { sha256 } from "../domain/ids.js";
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

interface StoredStreamCampaign {
  streamId: string;
  campaignId: string;
  createdAt: string;
}

interface FirestoreCollections {
  campaigns: string;
  controls: string;
  eventClaims: string;
  providerPublications: string;
  streamCampaigns: string;
}

export interface FirestoreStateStoreOptions {
  now?: StorageClock;
  collections?: Partial<FirestoreCollections>;
}

const DEFAULT_COLLECTIONS: FirestoreCollections = {
  campaigns: "creatorDutyCampaigns",
  controls: "creatorDutyControls",
  eventClaims: "creatorDutyEventClaims",
  providerPublications: "creatorDutyProviderPublications",
  streamCampaigns: "creatorDutyStreamCampaigns",
};

/**
 * Firestore-backed state using transactions for every compare-and-set boundary.
 * Values are stored as plain JSON-compatible objects with ISO timestamps.
 */
export class FirestoreStateStore implements StateStore {
  private readonly now: StorageClock;
  private readonly collections: FirestoreCollections;

  constructor(
    private readonly firestore: Firestore,
    options: FirestoreStateStoreOptions = {},
  ) {
    this.now = options.now ?? defaultStorageClock;
    this.collections = { ...DEFAULT_COLLECTIONS, ...options.collections };
  }

  async reserveDemoStart(policy: DemoStartPolicy): Promise<DemoStartDecision> {
    const now = this.now();
    const quotaRef = this.firestore.collection(this.collections.controls).doc("demoStartQuota");
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(quotaRef);
      const existing = snapshot.exists ? readDemoStartQuota(snapshot) : undefined;
      const reservation = calculateDemoStartReservation(existing, policy, now);
      if (reservation.state !== undefined) {
        transaction.set(quotaRef, toFirestoreData(reservation.state));
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
    const eventRef = this.firestore.collection(this.collections.eventClaims).doc(event.eventId);

    return this.firestore.runTransaction(async (transaction) => {
      const eventSnapshot = await transaction.get(eventRef);
      if (eventSnapshot.exists) {
        const existingClaim = readEventClaim(eventSnapshot);
        if (existingClaim.payloadFingerprint !== payloadFingerprint) {
          throw new StorageIntegrityError(
            `Event ID ${event.eventId} was replayed with a different payload.`,
          );
        }
        const campaignRef = this.campaignRef(existingClaim.campaignId);
        const campaignSnapshot = await transaction.get(campaignRef);
        const campaign = readRequiredCampaign(campaignSnapshot, existingClaim.campaignId);
        return eventClaimResult(
          existingClaim,
          isReplayComplete(campaign.stage) ? "duplicate_ignored" : "resumed",
        );
      }

      const campaignRef = this.campaignRef(initialCampaign.campaignId);
      const campaignSnapshot = await transaction.get(campaignRef);
      const campaignForIndex = campaignSnapshot.exists
        ? readCampaign(campaignSnapshot)
        : initialCampaign;
      if (campaignSnapshot.exists) {
        validateExistingCampaign(initialCampaign, campaignForIndex);
      }
      const streamRef = this.streamRef(initialCampaign.streamId);
      const streamSnapshot = await transaction.get(streamRef);
      const currentStream = streamSnapshot.exists ? readStreamCampaign(streamSnapshot) : null;
      if (currentStream && currentStream.streamId !== initialCampaign.streamId) {
        throw new StorageIntegrityError(
          `Stream campaign hash collision for ${initialCampaign.streamId}.`,
        );
      }

      const storedClaim: StoredEventClaim = {
        eventId: event.eventId,
        campaignId: initialCampaign.campaignId,
        claimedAt: this.now(),
        eventType: event.eventType,
        payloadFingerprint,
      };

      if (!campaignSnapshot.exists) {
        transaction.create(campaignRef, toFirestoreData(initialCampaign));
      }
      if (shouldReplaceStreamIndex(currentStream, campaignForIndex)) {
        transaction.set(
          streamRef,
          toFirestoreData({
            streamId: campaignForIndex.streamId,
            campaignId: campaignForIndex.campaignId,
            createdAt: campaignForIndex.createdAt,
          } satisfies StoredStreamCampaign),
        );
      }
      transaction.create(eventRef, toFirestoreData(storedClaim));
      return eventClaimResult(storedClaim, "claimed");
    });
  }

  async createCampaign(campaign: CampaignRecord): Promise<CampaignRecord> {
    const campaignRef = this.campaignRef(campaign.campaignId);
    const streamRef = this.streamRef(campaign.streamId);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(campaignRef);
      const streamSnapshot = await transaction.get(streamRef);
      if (snapshot.exists) {
        throw new CampaignAlreadyExistsError(campaign.campaignId);
      }
      const currentStream = streamSnapshot.exists ? readStreamCampaign(streamSnapshot) : null;
      if (currentStream && currentStream.streamId !== campaign.streamId) {
        throw new StorageIntegrityError(`Stream campaign hash collision for ${campaign.streamId}.`);
      }
      transaction.create(campaignRef, toFirestoreData(campaign));
      if (shouldReplaceStreamIndex(currentStream, campaign)) {
        transaction.set(
          streamRef,
          toFirestoreData({
            streamId: campaign.streamId,
            campaignId: campaign.campaignId,
            createdAt: campaign.createdAt,
          } satisfies StoredStreamCampaign),
        );
      }
    });
    return cloneStorageValue(campaign);
  }

  async getCampaign(campaignId: string): Promise<CampaignRecord | null> {
    const snapshot = await this.campaignRef(campaignId).get();
    return snapshot.exists ? cloneStorageValue(readCampaign(snapshot)) : null;
  }

  async updateCampaign(
    campaignId: string,
    updater: CampaignUpdater,
  ): Promise<CampaignRecord> {
    const campaignRef = this.campaignRef(campaignId);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(campaignRef);
      const existing = readRequiredCampaign(snapshot, campaignId);
      const updated = applyCampaignUpdate(existing, updater, this.now());
      transaction.set(campaignRef, toFirestoreData(updated));
      return cloneStorageValue(updated);
    });
  }

  async getCampaignByStream(streamId: string): Promise<CampaignRecord | null> {
    const streamSnapshot = await this.streamRef(streamId).get();
    if (!streamSnapshot.exists) {
      return null;
    }
    const streamCampaign = readStreamCampaign(streamSnapshot);
    if (streamCampaign.streamId !== streamId) {
      throw new StorageIntegrityError(`Stream campaign hash collision for ${streamId}.`);
    }
    const campaign = await this.getCampaign(streamCampaign.campaignId);
    if (!campaign) {
      throw new StorageIntegrityError(
        `Stream ${streamId} references missing campaign ${streamCampaign.campaignId}.`,
      );
    }
    return campaign;
  }

  async getLatestCampaign(): Promise<CampaignRecord | null> {
    const snapshot = await this.firestore
      .collection(this.collections.campaigns)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    const document = snapshot.docs[0];
    return document ? cloneStorageValue(readCampaign(document)) : null;
  }

  async listCampaigns(limit?: number): Promise<CampaignRecord[]> {
    const normalizedLimit = normalizeListLimit(limit);
    if (normalizedLimit === 0) {
      return [];
    }
    const snapshot = await this.firestore
      .collection(this.collections.campaigns)
      .orderBy("createdAt", "desc")
      .limit(normalizedLimit)
      .get();
    return snapshot.docs.map((document) => cloneStorageValue(readCampaign(document)));
  }

  async acquireCampaignLease(campaignId: string, ownerId: string, ttlMs: number): Promise<boolean> {
    if (!ownerId.trim()) throw new TypeError("Campaign lease ownerId is required.");
    const campaignRef = this.campaignRef(campaignId);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(campaignRef);
      const campaign = readRequiredCampaign(snapshot, campaignId);
      const now = this.now();
      if (
        leaseIsActive(campaign.executionLease, now) &&
        campaign.executionLease?.ownerId !== ownerId
      ) {
        return false;
      }
      campaign.executionLease = {
        ownerId,
        acquiredAt: now,
        expiresAt: leaseExpiration(now, ttlMs),
      };
      campaign.updatedAt = now;
      transaction.set(campaignRef, toFirestoreData(campaign));
      return true;
    });
  }

  async releaseCampaignLease(campaignId: string, ownerId: string): Promise<void> {
    const campaignRef = this.campaignRef(campaignId);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(campaignRef);
      const campaign = readRequiredCampaign(snapshot, campaignId);
      if (campaign.executionLease?.ownerId !== ownerId) return;
      delete campaign.executionLease;
      campaign.updatedAt = this.now();
      transaction.set(campaignRef, toFirestoreData(campaign));
    });
  }

  async getProviderPublication(idempotencyKey: string): Promise<ProviderPublication | null> {
    const snapshot = await this.publicationRef(idempotencyKey).get();
    if (!snapshot.exists) {
      return null;
    }
    const publication = readPublication(snapshot);
    if (publication.idempotencyKey !== idempotencyKey) {
      throw new StorageIntegrityError(
        `Provider publication hash collision for ${idempotencyKey}.`,
      );
    }
    return cloneStorageValue(publication);
  }

  async recordProviderPublication(
    publication: ProviderPublication,
  ): Promise<ProviderPublication> {
    const publicationRef = this.publicationRef(publication.idempotencyKey);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(publicationRef);
      if (snapshot.exists) {
        const existing = readPublication(snapshot);
        if (!publicationsMatch(existing, publication)) {
          throw new ProviderPublicationConflictError(publication.idempotencyKey);
        }
        return cloneStorageValue(existing);
      }

      transaction.create(publicationRef, toFirestoreData(publication));
      return cloneStorageValue(publication);
    });
  }

  private campaignRef(campaignId: string) {
    return this.firestore.collection(this.collections.campaigns).doc(campaignId);
  }

  private publicationRef(idempotencyKey: string) {
    return this.firestore
      .collection(this.collections.providerPublications)
      .doc(sha256(idempotencyKey));
  }

  private streamRef(streamId: string) {
    return this.firestore.collection(this.collections.streamCampaigns).doc(sha256(streamId));
  }
}

function readEventClaim(snapshot: DocumentSnapshot): StoredEventClaim {
  const data = snapshot.data();
  if (
    !data ||
    typeof data.eventId !== "string" ||
    typeof data.campaignId !== "string" ||
    typeof data.claimedAt !== "string" ||
    typeof data.payloadFingerprint !== "string" ||
    (data.eventType !== "creator.live.started" && data.eventType !== "creator.live.ended")
  ) {
    throw new StorageIntegrityError(`Malformed event claim document: ${snapshot.id}.`);
  }
  return {
    eventId: data.eventId,
    campaignId: data.campaignId,
    claimedAt: data.claimedAt,
    eventType: data.eventType,
    payloadFingerprint: data.payloadFingerprint,
  };
}

function readDemoStartQuota(snapshot: DocumentSnapshot): DemoStartQuotaState {
  const data = snapshot.data();
  if (
    !data ||
    typeof data.utcDate !== "string" ||
    typeof data.startedCount !== "number" ||
    typeof data.lastStartedAt !== "string"
  ) {
    throw new StorageIntegrityError(`Malformed demo-start quota document: ${snapshot.id}.`);
  }
  return {
    utcDate: data.utcDate,
    startedCount: data.startedCount,
    lastStartedAt: data.lastStartedAt,
  };
}

function readStreamCampaign(snapshot: DocumentSnapshot): StoredStreamCampaign {
  const data = snapshot.data();
  if (
    !data ||
    typeof data.streamId !== "string" ||
    typeof data.campaignId !== "string" ||
    typeof data.createdAt !== "string"
  ) {
    throw new StorageIntegrityError(`Malformed stream campaign document: ${snapshot.id}.`);
  }
  return {
    streamId: data.streamId,
    campaignId: data.campaignId,
    createdAt: data.createdAt,
  };
}

function shouldReplaceStreamIndex(
  current: StoredStreamCampaign | null,
  candidate: CampaignRecord,
): boolean {
  if (!current) {
    return true;
  }
  return (
    candidate.createdAt > current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.campaignId > current.campaignId)
  );
}

function eventClaimResult(
  stored: StoredEventClaim,
  disposition: EventClaim["disposition"],
): EventClaim {
  return {
    eventId: stored.eventId,
    campaignId: stored.campaignId,
    claimedAt: stored.claimedAt,
    eventType: stored.eventType,
    disposition,
  };
}

function readCampaign(snapshot: DocumentSnapshot): CampaignRecord {
  return cloneStorageValue(snapshot.data() as CampaignRecord);
}

function readRequiredCampaign(
  snapshot: DocumentSnapshot,
  campaignId: string,
): CampaignRecord {
  if (!snapshot.exists) {
    throw new CampaignNotFoundError(campaignId);
  }
  return readCampaign(snapshot);
}

function readPublication(snapshot: DocumentSnapshot): ProviderPublication {
  return cloneStorageValue(snapshot.data() as ProviderPublication);
}

/** Firestore rejects explicit `undefined`; domain records use omitted optionals. */
function toFirestoreData(value: unknown): DocumentData {
  if (Array.isArray(value)) {
    return value.map((item) => toFirestoreValue(item)) as unknown as DocumentData;
  }
  if (value === null || typeof value !== "object") {
    throw new StorageIntegrityError("Firestore document roots must be objects.");
  }
  return toFirestoreValue(value) as DocumentData;
}

function toFirestoreValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(toFirestoreValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, toFirestoreValue(child)]),
    );
  }
  return value;
}
