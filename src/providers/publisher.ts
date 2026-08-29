import { z } from "zod";

import { canonicalJson, stableId } from "../domain/ids.js";
import type {
  CampaignArtifact,
  Channel,
  ChannelVariant,
  ProviderPublication,
} from "../domain/types.js";
import type { StateStore } from "../storage/state-store.js";

export interface PublishRequest {
  campaignId: string;
  channel: Channel;
  variant: ChannelVariant;
  artifact: CampaignArtifact;
  releaseHash: string;
  idempotencyKey: string;
}

export interface Publisher {
  readonly name: string;
  publish(request: PublishRequest): Promise<ProviderPublication>;
  lookup(idempotencyKey: string): Promise<ProviderPublication | undefined>;
  verify(publication: ProviderPublication): Promise<boolean>;
}

export class PublishError extends Error {
  public override readonly name = "PublishError";

  public constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly ambiguous: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type PublicationStore = Pick<
  StateStore,
  "getProviderPublication" | "recordProviderPublication"
>;

export type FailureSelector =
  | Channel
  | readonly Channel[]
  | ((request: PublishRequest) => boolean);

export interface DeterministicSandboxPublisherOptions {
  publicBaseUrl?: string;
  /** Fail once before any durable post exists. Safe for a targeted retry. */
  failBeforeCommitOnce?: FailureSelector;
  /** Commit once, then lose the response. Callers must reconcile with lookup. */
  failAfterCommitOnce?: FailureSelector;
}

/**
 * Deterministic, durable sandbox destination. The StateStore record is the
 * provider's committed post, so process restarts cannot create duplicates.
 */
export class DeterministicSandboxPublisher implements Publisher {
  public readonly name = "deterministic_sandbox";

  private readonly beforeCommitFailures = new Set<string>();
  private readonly afterCommitFailures = new Set<string>();
  private readonly publicBaseUrl: string;

  public constructor(
    private readonly store: PublicationStore,
    private readonly options: DeterministicSandboxPublisherOptions = {},
  ) {
    this.publicBaseUrl = normalizePublicBaseUrl(
      options.publicBaseUrl ?? "https://sandbox.sigmora.invalid/posts",
    );
  }

  public async publish(request: PublishRequest): Promise<ProviderPublication> {
    assertPublishRequest(request);
    const expected = expectedSandboxIdentity(request, this.publicBaseUrl);
    const existing = await this.store.getProviderPublication(request.idempotencyKey);
    if (existing) {
      assertCompatible(existing, expected, request.idempotencyKey);
      return existing;
    }

    if (
      shouldFail(this.options.failBeforeCommitOnce, request) &&
      !this.beforeCommitFailures.has(request.idempotencyKey)
    ) {
      this.beforeCommitFailures.add(request.idempotencyKey);
      throw new PublishError(
        `Injected transient failure before ${request.channel} committed.`,
        "SANDBOX_TRANSIENT_BEFORE_COMMIT",
        true,
        false,
      );
    }

    const proposed: ProviderPublication = {
      ...expected,
      committedAt: new Date().toISOString(),
    };

    let committed: ProviderPublication;
    try {
      committed = await this.store.recordProviderPublication(proposed);
      assertCompatible(committed, expected, request.idempotencyKey);
    } catch (error) {
      const observed = await this.safeLookupAfterWriteFailure(request.idempotencyKey);
      if (observed) {
        assertCompatible(observed, expected, request.idempotencyKey);
        committed = observed;
      } else {
        throw new PublishError(
          `The sandbox could not prove whether ${request.channel} committed.`,
          "SANDBOX_COMMIT_UNAVAILABLE",
          true,
          true,
          { cause: error },
        );
      }
    }

    if (
      shouldFail(this.options.failAfterCommitOnce, request) &&
      !this.afterCommitFailures.has(request.idempotencyKey)
    ) {
      this.afterCommitFailures.add(request.idempotencyKey);
      throw new PublishError(
        `Injected lost response after ${request.channel} committed.`,
        "SANDBOX_AMBIGUOUS_AFTER_COMMIT",
        true,
        true,
      );
    }
    return committed;
  }

  public lookup(idempotencyKey: string): Promise<ProviderPublication | undefined> {
    if (!idempotencyKey.trim()) return Promise.resolve(undefined);
    return this.store
      .getProviderPublication(idempotencyKey)
      .then((publication) => publication ?? undefined);
  }

  public async verify(publication: ProviderPublication): Promise<boolean> {
    const observed = await this.lookup(publication.idempotencyKey);
    return observed !== undefined && samePublication(observed, publication);
  }

  private async safeLookupAfterWriteFailure(
    idempotencyKey: string,
  ): Promise<ProviderPublication | undefined> {
    try {
      return (await this.store.getProviderPublication(idempotencyKey)) ?? undefined;
    } catch {
      return undefined;
    }
  }
}

const providerPublicationSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(255),
    channel: z.enum(["x", "linkedin", "instagram", "youtube_shorts"]),
    providerPostId: z.string().min(1).max(512),
    providerUrl: z.url(),
    committedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const sigmoraPublicationResponseSchema = z.union([
  providerPublicationSchema,
  z.object({ publication: providerPublicationSchema }).strict().transform(({ publication }) => publication),
]);

export interface SigmoraPublisherOptions {
  baseUrl: string;
  token: string;
  publishEndpoint?: string;
  lookupEndpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Narrow publishing boundary; credentials and arbitrary provider tools stay in Sigmora. */
export class SigmoraPublisher implements Publisher {
  public readonly name = "sigmora_scoped_publisher";

  private readonly fetchImpl: typeof fetch;
  private readonly publishEndpoint: URL;
  private readonly lookupEndpoint: URL;
  private readonly timeoutMs: number;

  public constructor(private readonly options: SigmoraPublisherOptions) {
    if (!options.token.trim()) throw new Error("A Sigmora publishing token is required.");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.publishEndpoint = resolveEndpoint(
      options.baseUrl,
      options.publishEndpoint ?? "v1/creator-duty/publications",
    );
    this.lookupEndpoint = resolveEndpoint(
      options.baseUrl,
      options.lookupEndpoint ?? "v1/creator-duty/publications/by-idempotency/",
    );
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  public async publish(request: PublishRequest): Promise<ProviderPublication> {
    assertPublishRequest(request);
    let response: Response;
    try {
      response = await this.fetchImpl(this.publishEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify({
          campaignId: request.campaignId,
          channel: request.channel,
          variant: request.variant,
          artifact: {
            artifactId: request.artifact.artifactId,
            uri: request.artifact.uri,
            mimeType: request.artifact.mimeType,
            sha256: request.artifact.sha256,
          },
          releaseHash: request.releaseHash,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new PublishError(
        "Sigmora publishing response was lost or unavailable.",
        "SIGMORA_NETWORK_ERROR",
        true,
        true,
        { cause: error },
      );
    }

    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 409) {
        throw new PublishError(
          "Sigmora rejected conflicting idempotency.",
          "IDEMPOTENCY_CONFLICT",
          false,
          false,
        );
      }
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new PublishError(
        `Sigmora publish failed with HTTP ${response.status}.`,
        "SIGMORA_PUBLISH_FAILED",
        retryable,
        response.status >= 500,
      );
    }

    const publication = sigmoraPublicationResponseSchema.parse(await response.json());
    if (
      publication.idempotencyKey !== request.idempotencyKey ||
      publication.channel !== request.channel
    ) {
      throw new PublishError(
        "Sigmora returned a publication for a different logical request.",
        "SIGMORA_RESPONSE_MISMATCH",
        false,
        false,
      );
    }
    return publication;
  }

  public async lookup(idempotencyKey: string): Promise<ProviderPublication | undefined> {
    if (!idempotencyKey.trim()) return undefined;
    const endpoint = new URL(encodeURIComponent(idempotencyKey), this.lookupEndpoint);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.options.token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new PublishError(
        "Sigmora publication lookup is unavailable.",
        "SIGMORA_LOOKUP_UNAVAILABLE",
        true,
        true,
        { cause: error },
      );
    }
    if (response.status === 404) return undefined;
    if (!response.ok) {
      await response.body?.cancel();
      throw new PublishError(
        `Sigmora publication lookup failed with HTTP ${response.status}.`,
        "SIGMORA_LOOKUP_FAILED",
        response.status === 408 || response.status === 429 || response.status >= 500,
        false,
      );
    }
    return sigmoraPublicationResponseSchema.parse(await response.json());
  }

  public async verify(publication: ProviderPublication): Promise<boolean> {
    const observed = await this.lookup(publication.idempotencyKey);
    return observed !== undefined && samePublication(observed, publication);
  }
}

function expectedSandboxIdentity(
  request: PublishRequest,
  publicBaseUrl: string,
): Omit<ProviderPublication, "committedAt"> {
  const postId = stableId(
    "sandbox_post",
    canonicalJson({
      campaignId: request.campaignId,
      channel: request.channel,
      variant: request.variant,
      artifactId: request.artifact.artifactId,
      artifactSha256: request.artifact.sha256,
      releaseHash: request.releaseHash,
    }),
    32,
  );
  return {
    idempotencyKey: request.idempotencyKey,
    channel: request.channel,
    providerPostId: postId,
    providerUrl: `${publicBaseUrl}/${encodeURIComponent(postId)}`,
  };
}

function assertCompatible(
  publication: ProviderPublication,
  expected: Omit<ProviderPublication, "committedAt">,
  idempotencyKey: string,
): void {
  if (
    publication.idempotencyKey !== expected.idempotencyKey ||
    publication.channel !== expected.channel ||
    publication.providerPostId !== expected.providerPostId ||
    publication.providerUrl !== expected.providerUrl
  ) {
    throw new PublishError(
      `Idempotency key '${idempotencyKey}' was already used for different publication semantics.`,
      "IDEMPOTENCY_CONFLICT",
      false,
      false,
    );
  }
}

function assertPublishRequest(request: PublishRequest): void {
  if (!request.campaignId.trim()) throw new Error("campaignId is required for publishing.");
  if (!request.idempotencyKey.trim() || request.idempotencyKey.length > 255) {
    throw new Error("A bounded idempotencyKey is required for publishing.");
  }
  if (!/^[a-f0-9]{64}$/i.test(request.releaseHash)) {
    throw new Error("A SHA-256 releaseHash is required for publishing.");
  }
  if (request.variant.channel !== request.channel) {
    throw new Error("The channel variant does not match the requested destination.");
  }
  if (!/^[a-f0-9]{64}$/i.test(request.artifact.sha256)) {
    throw new Error("The immutable artifact SHA-256 is required for publishing.");
  }
}

function shouldFail(selector: FailureSelector | undefined, request: PublishRequest): boolean {
  if (selector === undefined) return false;
  if (typeof selector === "function") return selector(request);
  if (typeof selector === "string") return selector === request.channel;
  return selector.includes(request.channel);
}

function samePublication(left: ProviderPublication, right: ProviderPublication): boolean {
  return left.idempotencyKey === right.idempotencyKey &&
    left.channel === right.channel &&
    left.providerPostId === right.providerPostId &&
    left.providerUrl === right.providerUrl &&
    left.committedAt === right.committedAt;
}

function normalizePublicBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Sandbox publication URLs must use HTTPS outside local development.");
  }
  return url.toString().replace(/\/+$/, "");
}

function resolveEndpoint(baseUrl: string, endpoint: string): URL {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
    throw new Error("Sigmora publisher base URL must use HTTPS outside local development.");
  }
  const normalizedBase = `${base.toString().replace(/\/+$/, "")}/`;
  return new URL(endpoint.replace(/^\/+/, ""), normalizedBase);
}
