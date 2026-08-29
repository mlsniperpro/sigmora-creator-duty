import { createHash } from "node:crypto";

import type { CampaignRecord } from "./domain/types.js";
import { bootstrap, type CreatorDutyRuntime } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { MemoryLogger } from "./logging/logger.js";
import type { DispatchReceipt } from "./providers/events.js";

async function runDemo(): Promise<void> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    STORE_PROVIDER: "memory",
    MODEL_PROVIDER: "deterministic",
    MEDIA_PROVIDER: "deterministic",
    PUBLISH_PROVIDER: "deterministic",
    ALLOW_DEMO_TRIGGER: "true",
    ALLOW_UNAUTHENTICATED_PUBSUB: "true",
    ENABLE_VEO: "false",
    ENABLE_LYRIA: "false",
    ENABLE_GEMMA: "false",
    ARTIFACT_BUCKET: "",
  });
  const runtime = await bootstrap({ config, logger: new MemoryLogger() });
  try {
    const startEvent = await runtime.demoEvents.freshStart();
    const start = requireDirectResult(await runtime.dispatcher.dispatch(startEvent));
    const replayEvent = await runtime.demoEvents.replayStart(await runtime.store.getLatestCampaign());
    const replay = requireDirectResult(await runtime.dispatcher.dispatch(replayEvent));
    const endEvent = await runtime.demoEvents.end(await runtime.store.getLatestCampaign());
    const end = requireDirectResult(await runtime.dispatcher.dispatch(endEvent));
    const campaign = await runtime.store.getCampaign(start.result.campaignId);
    if (campaign === null) throw new Error("Demo campaign disappeared after processing.");

    process.stdout.write(`${JSON.stringify(createEvidence(runtime, campaign, start, replay, end), null, 2)}\n`);
  } finally {
    await runtime.close();
  }
}

function requireDirectResult(receipt: DispatchReceipt): Required<Pick<DispatchReceipt, "result">> & DispatchReceipt {
  if (receipt.transport !== "direct" || receipt.result === undefined) {
    throw new Error("The local demo requires an awaited direct dispatcher result.");
  }
  return receipt as Required<Pick<DispatchReceipt, "result">> & DispatchReceipt;
}

function createEvidence(
  runtime: CreatorDutyRuntime,
  campaign: CampaignRecord,
  start: Required<Pick<DispatchReceipt, "result">> & DispatchReceipt,
  replay: Required<Pick<DispatchReceipt, "result">> & DispatchReceipt,
  end: Required<Pick<DispatchReceipt, "result">> & DispatchReceipt,
): Record<string, unknown> {
  return {
    ok: campaign.stage === "closed" && campaign.validation?.passed === true,
    campaignId: campaign.campaignId,
    runId: campaign.runId,
    traceId: campaign.traceId,
    stage: campaign.stage,
    provider: {
      model: `${runtime.system.modelProvider}:${runtime.system.primaryModel}`,
      media: runtime.system.mediaProvider,
      publish: runtime.system.publishProvider,
      transport: runtime.system.eventTransport,
    },
    workflow: {
      start: summarizeReceipt(start),
      replay: summarizeReceipt(replay),
      end: summarizeReceipt(end),
    },
    policy: campaign.validation === undefined
      ? null
      : {
          validationId: campaign.validation.validationId,
          passed: campaign.validation.passed,
          releaseHash: campaign.validation.releaseHash,
        },
    artifacts: campaign.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      sha256: artifact.sha256,
      provider: artifact.provider,
    })),
    publications: campaign.receipts.map((receipt) => ({
      channel: receipt.channel,
      status: receipt.status,
      attempt: receipt.attempt,
      receiptId: receipt.receiptId,
      providerPostId: receipt.providerPostId,
    })),
    modelEvidence: campaign.invocations.map((invocation) => ({
      purpose: invocation.purpose,
      provider: invocation.provider,
      model: invocation.model,
      modelVersion: invocation.modelVersion,
      responseId: invocation.responseId,
    })),
    recap: campaign.recap === undefined
      ? null
      : {
          headline: campaign.recap.headline,
          questionClusterCount: campaign.recap.questionClusters.length,
        },
    metrics: campaign.metrics,
    evidenceDigest: createHash("sha256")
      .update(JSON.stringify({
        campaignId: campaign.campaignId,
        validation: campaign.validation,
        artifacts: campaign.artifacts.map(({ artifactId, sha256 }) => ({ artifactId, sha256 })),
        receipts: campaign.receipts,
      }))
      .digest("hex"),
  };
}

function summarizeReceipt(receipt: Required<Pick<DispatchReceipt, "result">> & DispatchReceipt): object {
  return {
    eventId: receipt.eventId,
    disposition: receipt.result.disposition,
    outcome: receipt.result.outcome,
    stage: receipt.result.stage,
  };
}

if (process.argv[2] !== "demo") {
  process.stderr.write(`${JSON.stringify({ ok: false, error: "usage", command: "npm run demo" })}\n`);
  process.exitCode = 2;
} else {
  void runDemo().catch(() => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: "demo_failed" })}\n`);
    process.exitCode = 1;
  });
}
