import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { Firestore } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";

import {
  ArtifactProxyError,
  FixtureDemoEventFactory,
  type ArtifactByteRange,
  type ArtifactReader,
  type ArtifactResource,
  type CreatorDutyApplicationDependencies,
  type SystemDescriptor,
} from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import type { CampaignArtifact } from "./domain/types.js";
import { JsonLogger, type Logger } from "./logging/logger.js";
import { createCampaignCritic, createModelAgent } from "./models/index.js";
import { CreatorDutyOrchestrator, type AdditionalMediaProvider } from "./orchestration/orchestrator.js";
import { DirectEventDispatcher, PubSubEventDispatcher } from "./providers/events.js";
import {
  GoogleAdditionalMediaProvider,
  LyriaAdditionalMediaProvider,
  VeoAdditionalMediaProvider,
} from "./providers/google-media.js";
import {
  DeterministicMediaRenderer,
  GcsArtifactStore,
  SigmoraMediaRenderer,
  type ArtifactObjectStore,
  type MediaRenderer,
} from "./providers/media.js";
import {
  DeterministicSandboxPublisher,
  SigmoraPublisher,
  type Publisher,
} from "./providers/publisher.js";
import { FixtureSourceProvider } from "./providers/source.js";
import { FirestoreStateStore, MemoryStateStore, type StateStore } from "./storage/index.js";

export interface CreatorDutyRuntime extends CreatorDutyApplicationDependencies {
  logger: Logger;
  close(): Promise<void>;
}

export interface BootstrapOptions {
  config?: AppConfig;
  logger?: Logger;
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<CreatorDutyRuntime> {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? new JsonLogger();
  const firestore = createFirestore(config);
  const store: StateStore = firestore === undefined
    ? new MemoryStateStore()
    : new FirestoreStateStore(firestore);

  const storage = new Storage(
    config.googleCloudProject === undefined ? {} : { projectId: config.googleCloudProject },
  );
  const objectStore = createArtifactObjectStore(config, storage);
  const model = createModelAgent(config);
  const critic = createCampaignCritic(config);
  const media = createMediaRenderer(config, objectStore);
  const publisher = createPublisher(config, store);
  const additionalMedia = createAdditionalMedia(config, objectStore);
  const source = new FixtureSourceProvider(config.fixtureDirectory);

  const orchestrator = new CreatorDutyOrchestrator({
    config,
    store,
    source,
    model,
    media,
    publisher,
    logger,
    ...(critic === undefined ? {} : { critic }),
    ...(additionalMedia === undefined ? {} : { additionalMedia }),
  });
  const eventTransport = config.nodeEnv === "production" ? "pubsub" : "direct";
  const dispatcher = eventTransport === "pubsub"
    ? new PubSubEventDispatcher(config.pubsubTopic, config.googleCloudProject)
    : new DirectEventDispatcher((event) => orchestrator.process(event));
  const system: SystemDescriptor = {
    service: "creator-duty",
    environment: config.nodeEnv,
    storeProvider: config.storeProvider,
    modelProvider: model.provider,
    primaryModel: model.model,
    mediaProvider: media.name,
    publishProvider: publisher.name,
    eventTransport,
    criticProvider: critic?.provider ?? null,
    criticModel: critic?.model ?? null,
    additionalMediaModels: [
      ...(config.enableVeo ? [config.veoModel] : []),
      ...(config.enableLyria ? [config.lyriaModel] : []),
    ],
  };

  return {
    config,
    store,
    orchestrator,
    dispatcher,
    system,
    artifactReader: new RuntimeArtifactReader(config, storage),
    demoEvents: new FixtureDemoEventFactory(config.fixtureDirectory),
    logger,
    readiness: async () => {
      await store.listCampaigns(1);
    },
    close: async () => {
      if (firestore !== undefined) await firestore.terminate();
    },
  };
}

function createFirestore(config: AppConfig): Firestore | undefined {
  if (config.storeProvider === "memory") return undefined;
  return new Firestore({
    databaseId: config.firestoreDatabaseId,
    ...(config.googleCloudProject === undefined ? {} : { projectId: config.googleCloudProject }),
  });
}

function createArtifactObjectStore(config: AppConfig, storage: Storage): ArtifactObjectStore | undefined {
  if (config.artifactBucket === undefined) return undefined;
  return new GcsArtifactStore(config.artifactBucket, {
    storage,
    ...(config.googleCloudProject === undefined ? {} : { projectId: config.googleCloudProject }),
  });
}

function createMediaRenderer(config: AppConfig, objectStore: ArtifactObjectStore | undefined): MediaRenderer {
  if (config.mediaProvider === "deterministic") {
    return new DeterministicMediaRenderer({
      artifactDirectory: config.artifactDirectory,
      artifactUrlPrefix: "/artifacts",
      ...(objectStore === undefined ? {} : { objectStore }),
    });
  }
  if (config.sigmoraApiBaseUrl === undefined || config.sigmoraApiToken === undefined) {
    throw new Error("Sigmora media configuration is incomplete.");
  }
  return new SigmoraMediaRenderer({
    baseUrl: config.sigmoraApiBaseUrl,
    token: config.sigmoraApiToken,
  });
}

function createPublisher(config: AppConfig, store: StateStore): Publisher {
  if (config.publishProvider === "deterministic") {
    return new DeterministicSandboxPublisher(store, {
      publicBaseUrl: `${config.baseUrl}/sandbox/posts`,
      failBeforeCommitOnce: "linkedin",
    });
  }
  if (config.sigmoraApiBaseUrl === undefined || config.sigmoraApiToken === undefined) {
    throw new Error("Sigmora publishing configuration is incomplete.");
  }
  return new SigmoraPublisher({
    baseUrl: config.sigmoraApiBaseUrl,
    token: config.sigmoraApiToken,
  });
}

function createAdditionalMedia(
  config: AppConfig,
  objectStore: ArtifactObjectStore | undefined,
): AdditionalMediaProvider | undefined {
  if (!config.enableVeo && !config.enableLyria) return undefined;
  if (config.googleCloudProject === undefined || objectStore === undefined || config.artifactBucket === undefined) {
    throw new Error("Enabled Google media requires a project and artifact bucket.");
  }
  const providers: AdditionalMediaProvider[] = [];
  if (config.enableVeo) {
    providers.push(new VeoAdditionalMediaProvider({
      model: config.veoModel,
      artifactDirectory: config.artifactDirectory,
      objectStore,
      projectId: config.googleCloudProject,
      location: config.googleMediaLocation,
      outputGcsUri: `gs://${config.artifactBucket}/generated/veo/`,
    }));
  }
  if (config.enableLyria) {
    providers.push(new LyriaAdditionalMediaProvider({
      projectId: config.googleCloudProject,
      model: config.lyriaModel,
      artifactDirectory: config.artifactDirectory,
      objectStore,
    }));
  }
  return new GoogleAdditionalMediaProvider(providers);
}

export class RuntimeArtifactReader implements ArtifactReader {
  private readonly artifactRoot: string;

  public constructor(
    private readonly config: Pick<AppConfig, "artifactDirectory" | "artifactBucket">,
    private readonly storage: Storage = new Storage(),
  ) {
    this.artifactRoot = path.resolve(config.artifactDirectory);
  }

  public async open(artifact: CampaignArtifact): Promise<ArtifactResource> {
    if (artifact.uri.startsWith("/artifacts/")) {
      return this.openLocal(artifact);
    }
    if (artifact.uri.startsWith("gs://")) {
      return this.openGcs(artifact);
    }
    throw new ArtifactProxyError(502, "unsupported_artifact_uri", "Unsupported artifact URI.");
  }

  private async openLocal(artifact: CampaignArtifact): Promise<ArtifactResource> {
    let fileName: string;
    try {
      fileName = decodeURIComponent(artifact.uri.slice("/artifacts/".length));
    } catch {
      throw new ArtifactProxyError(400, "invalid_artifact_uri", "Invalid local artifact URI.");
    }
    if (fileName.length === 0 || path.basename(fileName) !== fileName || fileName === "." || fileName === "..") {
      throw new ArtifactProxyError(400, "invalid_artifact_uri", "Invalid local artifact URI.");
    }
    const filePath = path.resolve(this.artifactRoot, fileName);
    if (!filePath.startsWith(`${this.artifactRoot}${path.sep}`)) {
      throw new ArtifactProxyError(400, "invalid_artifact_uri", "Invalid local artifact URI.");
    }
    try {
      const metadata = await stat(filePath);
      if (!metadata.isFile()) {
        throw new ArtifactProxyError(404, "artifact_not_found", "Artifact is not a file.");
      }
      return {
        contentType: artifact.mimeType,
        size: metadata.size,
        createReadStream: (range?: ArtifactByteRange) => createReadStream(
          filePath,
          range === undefined ? {} : { start: range.start, end: range.end },
        ),
      };
    } catch (error) {
      if (error instanceof ArtifactProxyError) throw error;
      if (isNotFound(error)) {
        throw new ArtifactProxyError(404, "artifact_not_found", "Artifact does not exist.");
      }
      throw new ArtifactProxyError(502, "artifact_unavailable", "Artifact could not be opened.");
    }
  }

  private async openGcs(artifact: CampaignArtifact): Promise<ArtifactResource> {
    const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(artifact.uri);
    if (match === null) {
      throw new ArtifactProxyError(400, "invalid_artifact_uri", "Invalid Cloud Storage URI.");
    }
    const bucket = match[1]!;
    const objectName = match[2]!;
    if (this.config.artifactBucket === undefined || bucket !== this.config.artifactBucket) {
      throw new ArtifactProxyError(403, "artifact_bucket_not_allowed", "Artifact bucket is not allowed.");
    }
    const file = this.storage.bucket(bucket).file(objectName);
    try {
      const [metadata] = await file.getMetadata();
      const size = Number(metadata.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new ArtifactProxyError(502, "artifact_metadata_invalid", "Artifact size is invalid.");
      }
      const recordedHash = metadata.metadata?.sha256;
      if (recordedHash !== undefined && recordedHash !== artifact.sha256) {
        throw new ArtifactProxyError(502, "artifact_integrity_failed", "Artifact hash evidence differs.");
      }
      return {
        contentType: metadata.contentType ?? artifact.mimeType,
        size,
        createReadStream: (range?: ArtifactByteRange) => {
          const stream = file.createReadStream(
            range === undefined ? {} : { start: range.start, end: range.end, validation: false },
          );
          // @google-cloud/storage composes several retry, integrity, and HTTP
          // listeners on its PassThrough. Node 24's default of ten is lower
          // than that legitimate per-stream listener set.
          stream.setMaxListeners(32);
          return stream;
        },
      };
    } catch (error) {
      if (error instanceof ArtifactProxyError) throw error;
      if (isNotFound(error)) {
        throw new ArtifactProxyError(404, "artifact_not_found", "Artifact does not exist.");
      }
      throw new ArtifactProxyError(502, "artifact_unavailable", "Artifact could not be opened.");
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === 404 || (error as { code?: unknown }).code === "ENOENT")
  );
}
