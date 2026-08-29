import path from "node:path";

import { z } from "zod";

const booleanFromEnvironment = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  APP_BASE_URL: z.url().default("http://localhost:8080"),
  STORE_PROVIDER: z.enum(["memory", "firestore"]).default("memory"),
  MODEL_PROVIDER: z.enum(["deterministic", "gemini_api", "vertex_ai"]).default("deterministic"),
  MEDIA_PROVIDER: z.enum(["deterministic", "sigmora"]).default("deterministic"),
  PUBLISH_PROVIDER: z.enum(["deterministic", "sigmora"]).default("deterministic"),
  ALLOW_DEMO_TRIGGER: booleanFromEnvironment,
  GOOGLE_CLOUD_PROJECT: optionalString,
  GOOGLE_CLOUD_LOCATION: z.string().min(1).default("global"),
  GOOGLE_MEDIA_LOCATION: z.string().min(1).default("us-central1"),
  GEMINI_MODEL: z.string().min(1).default("gemini-3.7-flash"),
  GEMINI_API_KEY: optionalString,
  FIRESTORE_DATABASE_ID: z.string().min(1).default("(default)"),
  PUBSUB_TOPIC: z.string().min(1).default("creator-duty-events"),
  PUBSUB_AUDIENCE: optionalString,
  PUBSUB_SERVICE_ACCOUNT_EMAIL: optionalString.pipe(z.email().optional()),
  ALLOW_UNAUTHENTICATED_PUBSUB: booleanFromEnvironment,
  DEMO_API_KEY: optionalString,
  DEMO_CREATOR_ID: z.string().min(3).default("demo_creator"),
  DEMO_DAILY_START_LIMIT: z.coerce.number().int().min(1).max(100).default(12),
  DEMO_START_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3_600).default(15),
  MAX_MODEL_SPEND_USD: z.coerce.number().positive().max(100).default(5),
  SIGMORA_API_BASE_URL: optionalString.pipe(z.url().optional()),
  SIGMORA_API_TOKEN: optionalString,
  ENABLE_VEO: booleanFromEnvironment,
  VEO_MODEL: z.string().min(1).default("veo-3.1-generate-preview"),
  ENABLE_LYRIA: booleanFromEnvironment,
  LYRIA_MODEL: z.string().min(1).default("lyria-3-clip-preview"),
  ENABLE_GEMMA: booleanFromEnvironment,
  GEMMA_MODEL: optionalString,
  ARTIFACT_BUCKET: optionalString,
  FIXTURE_DIRECTORY: optionalString,
  ARTIFACT_DIRECTORY: optionalString,
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  baseUrl: string;
  storeProvider: "memory" | "firestore";
  modelProvider: "deterministic" | "gemini_api" | "vertex_ai";
  mediaProvider: "deterministic" | "sigmora";
  publishProvider: "deterministic" | "sigmora";
  allowDemoTrigger: boolean;
  googleCloudProject?: string;
  googleCloudLocation: string;
  googleMediaLocation: string;
  geminiModel: string;
  geminiApiKey?: string;
  firestoreDatabaseId: string;
  pubsubTopic: string;
  pubsubAudience?: string;
  pubsubServiceAccountEmail?: string;
  allowUnauthenticatedPubsub: boolean;
  demoApiKey?: string;
  demoCreatorId: string;
  demoDailyStartLimit: number;
  demoStartCooldownSeconds: number;
  maxModelSpendUsd: number;
  sigmoraApiBaseUrl?: string;
  sigmoraApiToken?: string;
  enableVeo: boolean;
  veoModel: string;
  enableLyria: boolean;
  lyriaModel: string;
  enableGemma: boolean;
  gemmaModel?: string;
  artifactBucket?: string;
  fixtureDirectory: string;
  artifactDirectory: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = environmentSchema.parse(environment);
  const root = process.cwd();
  const config: AppConfig = {
    nodeEnv: raw.NODE_ENV,
    port: raw.PORT,
    baseUrl: raw.APP_BASE_URL.replace(/\/$/, ""),
    storeProvider: raw.STORE_PROVIDER,
    modelProvider: raw.MODEL_PROVIDER,
    mediaProvider: raw.MEDIA_PROVIDER,
    publishProvider: raw.PUBLISH_PROVIDER,
    allowDemoTrigger: raw.ALLOW_DEMO_TRIGGER,
    googleCloudLocation: raw.GOOGLE_CLOUD_LOCATION,
    googleMediaLocation: raw.GOOGLE_MEDIA_LOCATION,
    geminiModel: raw.GEMINI_MODEL,
    firestoreDatabaseId: raw.FIRESTORE_DATABASE_ID,
    pubsubTopic: raw.PUBSUB_TOPIC,
    allowUnauthenticatedPubsub: raw.ALLOW_UNAUTHENTICATED_PUBSUB,
    demoCreatorId: raw.DEMO_CREATOR_ID,
    demoDailyStartLimit: raw.DEMO_DAILY_START_LIMIT,
    demoStartCooldownSeconds: raw.DEMO_START_COOLDOWN_SECONDS,
    maxModelSpendUsd: raw.MAX_MODEL_SPEND_USD,
    enableVeo: raw.ENABLE_VEO,
    veoModel: raw.VEO_MODEL,
    enableLyria: raw.ENABLE_LYRIA,
    lyriaModel: raw.LYRIA_MODEL,
    enableGemma: raw.ENABLE_GEMMA,
    fixtureDirectory: raw.FIXTURE_DIRECTORY ?? path.join(root, "fixtures"),
    artifactDirectory: raw.ARTIFACT_DIRECTORY ?? path.join(root, "data", "artifacts"),
    ...(raw.GOOGLE_CLOUD_PROJECT === undefined ? {} : { googleCloudProject: raw.GOOGLE_CLOUD_PROJECT }),
    ...(raw.GEMINI_API_KEY === undefined ? {} : { geminiApiKey: raw.GEMINI_API_KEY }),
    ...(raw.PUBSUB_AUDIENCE === undefined ? {} : { pubsubAudience: raw.PUBSUB_AUDIENCE }),
    ...(raw.PUBSUB_SERVICE_ACCOUNT_EMAIL === undefined
      ? {}
      : { pubsubServiceAccountEmail: raw.PUBSUB_SERVICE_ACCOUNT_EMAIL }),
    ...(raw.DEMO_API_KEY === undefined ? {} : { demoApiKey: raw.DEMO_API_KEY }),
    ...(raw.SIGMORA_API_BASE_URL === undefined ? {} : { sigmoraApiBaseUrl: raw.SIGMORA_API_BASE_URL }),
    ...(raw.SIGMORA_API_TOKEN === undefined ? {} : { sigmoraApiToken: raw.SIGMORA_API_TOKEN }),
    ...(raw.GEMMA_MODEL === undefined ? {} : { gemmaModel: raw.GEMMA_MODEL }),
    ...(raw.ARTIFACT_BUCKET === undefined ? {} : { artifactBucket: raw.ARTIFACT_BUCKET }),
  };

  validateProviderRequirements(config);
  return config;
}

function validateProviderRequirements(config: AppConfig): void {
  if (config.nodeEnv === "production" && config.storeProvider !== "firestore") {
    throw new Error("Production requires STORE_PROVIDER=firestore for durable checkpoints.");
  }
  if (config.modelProvider === "vertex_ai" && !config.googleCloudProject) {
    throw new Error("MODEL_PROVIDER=vertex_ai requires GOOGLE_CLOUD_PROJECT.");
  }
  if (config.modelProvider === "gemini_api" && !config.geminiApiKey) {
    throw new Error("MODEL_PROVIDER=gemini_api requires GEMINI_API_KEY.");
  }
  if (config.nodeEnv === "production" && config.modelProvider === "deterministic") {
    throw new Error("Production cannot use the deterministic model; configure Gemini API or Vertex AI.");
  }
  if (config.nodeEnv === "production" && config.allowDemoTrigger && !config.demoApiKey) {
    throw new Error("A production demo trigger requires DEMO_API_KEY.");
  }
  if (
    config.nodeEnv === "production" &&
    !config.allowUnauthenticatedPubsub &&
    (!config.pubsubAudience || !config.pubsubServiceAccountEmail)
  ) {
    throw new Error(
      "Authenticated production Pub/Sub requires PUBSUB_AUDIENCE and PUBSUB_SERVICE_ACCOUNT_EMAIL.",
    );
  }
  if (
    (config.mediaProvider === "sigmora" || config.publishProvider === "sigmora") &&
    (!config.sigmoraApiBaseUrl || !config.sigmoraApiToken)
  ) {
    throw new Error("The Sigmora provider requires SIGMORA_API_BASE_URL and SIGMORA_API_TOKEN.");
  }
  if (config.enableGemma && !config.gemmaModel) {
    throw new Error("ENABLE_GEMMA=true requires an exact GEMMA_MODEL ID.");
  }
  if (config.enableLyria && (!config.googleCloudProject || !config.artifactBucket)) {
    throw new Error("Lyria requires GOOGLE_CLOUD_PROJECT and ARTIFACT_BUCKET.");
  }
  if (config.enableVeo && (!config.googleCloudProject || !config.artifactBucket)) {
    throw new Error("Veo requires GOOGLE_CLOUD_PROJECT and ARTIFACT_BUCKET.");
  }
}
