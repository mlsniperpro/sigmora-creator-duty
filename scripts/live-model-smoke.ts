import { readFile } from "node:fs/promises";
import path from "node:path";

import { creatorLiveEventSchema } from "../src/domain/schemas.js";
import type { LiveSource } from "../src/domain/types.js";
import { GeminiModelAgent } from "../src/models/index.js";

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION ?? "global";
const model = process.env.GEMINI_MODEL ?? "gemini-3.7-flash";
if (!project) throw new Error("GOOGLE_CLOUD_PROJECT is required.");

const [eventJson, sourceJson] = await Promise.all([
  readFile(path.join(process.cwd(), "fixtures", "live-started.json"), "utf8"),
  readFile(path.join(process.cwd(), "fixtures", "source.json"), "utf8"),
]);
const event = creatorLiveEventSchema.parse(JSON.parse(eventJson));
const source = JSON.parse(sourceJson) as LiveSource;
const agent = new GeminiModelAgent({ provider: "vertex_ai", model, project, location });
const result = await agent.planCampaign({ event, source, maxEstimatedModelSpendUsd: 5 });

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      sdk: result.evidence.sdk,
      provider: result.evidence.provider,
      requestedModel: result.evidence.requestedModel,
      resolvedModel: result.evidence.resolvedModel,
      responseId: result.evidence.responseId,
      finishReason: result.evidence.finishReason,
      channels: result.value.channels,
      selectedMoment: result.value.selectedMoment,
    },
    null,
    2,
  )}\n`,
);
