import { z } from "zod";

import { CAMPAIGN_STAGES, CHANNELS } from "./types.js";

export const channelSchema = z.enum(CHANNELS);

export const creatorLiveEventSchema = z
  .object({
    eventId: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
    eventType: z.enum(["creator.live.started", "creator.live.ended"]),
    occurredAt: z.iso.datetime({ offset: true }),
    creatorId: z.string().min(3).max(128).regex(/^[A-Za-z0-9_-]+$/),
    stream: z
      .object({
        streamId: z.string().min(3).max(128).regex(/^[A-Za-z0-9_-]+$/),
        title: z.string().min(1).max(200),
        url: z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
          message: "Stream URL must use HTTP or HTTPS.",
        }),
        sourceClipId: z.string().min(3).max(128),
        transcriptId: z.string().min(3).max(128),
      })
      .strict(),
    preauthorizationProfileId: z.string().min(3).max(128),
  })
  .strict();

export const pubSubPushEnvelopeSchema = z
  .object({
    deliveryAttempt: z.number().int().positive().optional(),
    message: z
      .object({
        data: z.string().min(1),
        messageId: z.string().optional(),
        message_id: z.string().optional(),
        publishTime: z.string().optional(),
        publish_time: z.string().optional(),
        orderingKey: z.string().max(1_024).optional(),
        attributes: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .superRefine((message, context) => {
        if (
          message.messageId !== undefined &&
          message.message_id !== undefined &&
          message.messageId !== message.message_id
        ) {
          context.addIssue({
            code: "custom",
            path: ["message_id"],
            message: "Pub/Sub message ID aliases must match.",
          });
        }
        if (
          message.publishTime !== undefined &&
          message.publish_time !== undefined &&
          message.publishTime !== message.publish_time
        ) {
          context.addIssue({
            code: "custom",
            path: ["publish_time"],
            message: "Pub/Sub publish time aliases must match.",
          });
        }
      }),
    subscription: z.string().optional(),
  })
  .strict();

export const campaignPlanSchema = z
  .object({
    angle: z.string().min(8).max(180),
    hook: z.string().min(8).max(140),
    tone: z.enum(["calm", "bold", "educational", "playful"]),
    selectedMoment: z
      .object({
        startSeconds: z.number().min(0),
        endSeconds: z.number().positive(),
        rationale: z.string().min(8).max(300),
      })
      .strict(),
    channels: z.array(channelSchema).min(3).max(4),
    estimatedModelSpendUsd: z.number().min(0).max(100),
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.selectedMoment.endSeconds <= plan.selectedMoment.startSeconds) {
      context.addIssue({
        code: "custom",
        path: ["selectedMoment", "endSeconds"],
        message: "Selected moment must end after it starts.",
      });
    }
    if (new Set(plan.channels).size !== plan.channels.length) {
      context.addIssue({ code: "custom", path: ["channels"], message: "Channels must be unique." });
    }
  });

export const channelVariantSchema = z
  .object({
    channel: channelSchema,
    copy: z.string().min(8).max(2_200),
    ctaUrl: z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
      message: "CTA URL must use HTTP or HTTPS.",
    }),
    hashtags: z
      .array(
        z
          .string()
          .max(80)
          .regex(/^#[A-Za-z0-9_]+$/)
          .describe("A hashtag beginning with # and containing only ASCII letters, digits, or underscores."),
      )
      .max(8)
      .describe("Zero to eight hashtags; every item must include its leading # character."),
  })
  .strict();

export const channelVariantsSchema = z
  .object({ variants: z.array(channelVariantSchema).min(3).max(4) })
  .strict()
  .superRefine(({ variants }, context) => {
    const channels = variants.map((variant) => variant.channel);
    if (new Set(channels).size !== channels.length) {
      context.addIssue({ code: "custom", path: ["variants"], message: "Variant channels must be unique." });
    }
  });

export const recapSchema = z
  .object({
    headline: z.string().min(8).max(160),
    summary: z.string().min(20).max(1_200),
    questionClusters: z
      .array(
        z
          .object({
            theme: z.string().min(3).max(100),
            questions: z.array(z.string().min(3).max(300)).min(1).max(10),
            suggestedAnswer: z.string().min(10).max(800),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export const criticResultSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            code: z.string().min(3).max(80),
            severity: z.enum(["info", "warning", "high"]),
            channel: channelSchema.optional(),
            message: z.string().min(5).max(400),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export const campaignStageSchema = z.enum(CAMPAIGN_STAGES);

export function decodePubSubEvent(input: unknown) {
  const envelope = pubSubPushEnvelopeSchema.parse(input);
  const compactBase64 = envelope.message.data.replaceAll(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compactBase64)) {
    throw new Error("Pub/Sub message.data is not valid base64.");
  }
  let decoded: string;
  try {
    const bytes = Buffer.from(compactBase64, "base64");
    const normalizedInput = compactBase64.replace(/=+$/, "");
    const normalizedRoundTrip = bytes.toString("base64").replace(/=+$/, "");
    if (normalizedInput !== normalizedRoundTrip) {
      throw new Error("Base64 round-trip mismatch.");
    }
    decoded = bytes.toString("utf8");
  } catch (error) {
    throw new Error("Pub/Sub message.data is not valid base64.", { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch (error) {
    throw new Error("Pub/Sub message.data does not contain JSON.", { cause: error });
  }
  return creatorLiveEventSchema.parse(parsed);
}

export const campaignPlanJsonSchema = z.toJSONSchema(campaignPlanSchema);
export const channelVariantsJsonSchema = z.toJSONSchema(channelVariantsSchema);
export const recapJsonSchema = z.toJSONSchema(recapSchema);
export const criticJsonSchema = z.toJSONSchema(criticResultSchema);
