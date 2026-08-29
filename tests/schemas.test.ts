import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  creatorLiveEventSchema,
  decodePubSubEvent,
} from "../src/domain/schemas.js";

const fixture = JSON.parse(
  readFileSync(path.join(process.cwd(), "fixtures", "live-started.json"), "utf8"),
) as unknown;

describe("event contracts", () => {
  it("accepts the documented hero fixture and decodes its Pub/Sub envelope", () => {
    const event = creatorLiveEventSchema.parse(fixture);
    const decoded = decodePubSubEvent({
      message: { data: Buffer.from(JSON.stringify(event), "utf8").toString("base64") },
    });
    expect(decoded).toEqual(event);
  });

  it("rejects unknown fields, unsupported protocols, malformed base64, and malformed JSON", () => {
    expect(() => creatorLiveEventSchema.parse({ ...(fixture as object), surprise: true })).toThrow();
    const invalidProtocol = structuredClone(fixture) as Record<string, unknown>;
    invalidProtocol.stream = {
      ...((invalidProtocol.stream ?? {}) as object),
      url: "javascript:alert(1)",
    };
    expect(() => creatorLiveEventSchema.parse(invalidProtocol)).toThrow("HTTP or HTTPS");
    expect(() => decodePubSubEvent({ message: { data: "%%%not-base64%%%" } })).toThrow(
      "not valid base64",
    );
    expect(() =>
      decodePubSubEvent({ message: { data: Buffer.from("not-json").toString("base64") } }),
    ).toThrow("does not contain JSON");
  });
});
