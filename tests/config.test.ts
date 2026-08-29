import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("configuration safety", () => {
  it("supports the zero-credential deterministic local path", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ALLOW_DEMO_TRIGGER: "true",
      ALLOW_UNAUTHENTICATED_PUBSUB: "true",
    });
    expect(config).toMatchObject({
      storeProvider: "memory",
      modelProvider: "deterministic",
      geminiModel: "gemini-3.7-flash",
    });
  });

  it("fails closed when production lacks durable state or a real Gemini provider", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow("STORE_PROVIDER=firestore");
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        STORE_PROVIDER: "firestore",
        MODEL_PROVIDER: "deterministic",
      }),
    ).toThrow("cannot use the deterministic model");
  });

  it("requires exact credentials for external providers", () => {
    expect(() => loadConfig({ NODE_ENV: "test", MODEL_PROVIDER: "gemini_api" })).toThrow(
      "GEMINI_API_KEY",
    );
    expect(() => loadConfig({ NODE_ENV: "test", MEDIA_PROVIDER: "sigmora" })).toThrow(
      "SIGMORA_API_BASE_URL",
    );
  });

  it("requires the exact Pub/Sub audience and push identity in production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      STORE_PROVIDER: "firestore",
      MODEL_PROVIDER: "vertex_ai",
      GOOGLE_CLOUD_PROJECT: "creator-duty-test",
      ALLOW_DEMO_TRIGGER: "false",
      PUBSUB_AUDIENCE: "https://creator-duty.example",
    })).toThrow("PUBSUB_SERVICE_ACCOUNT_EMAIL");
  });
});
