import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it } from "vitest";

import type {
  CampaignPlan,
  ChannelVariant,
  CreatorLiveEvent,
  LiveSource,
} from "../src/domain/types.js";
import {
  DeterministicModelAgent,
  GemmaCriticAdapter,
  GeminiModelAgent,
  ModelAgentError,
  toGoogleResponseJsonSchema,
  type GenerateContentResponseLike,
  type GoogleModelClient,
} from "../src/models/index.js";

const fixedNow = () => new Date("2026-08-30T12:00:01.000Z");
const event: CreatorLiveEvent = {
  eventId: "live_evt_demo_001",
  eventType: "creator.live.started",
  occurredAt: "2026-08-30T12:00:00Z",
  creatorId: "demo_creator",
  stream: {
    streamId: "stream_demo_001",
    title: "Building Creator Duty Live",
    url: "https://demo.invalid/live/creator-duty",
    sourceClipId: "clip_demo_001",
    transcriptId: "transcript_demo_001",
  },
  preauthorizationProfileId: "taskmaster_demo_v1",
};
const source: LiveSource = {
  sourceClipId: "clip_demo_001",
  transcriptId: "transcript_demo_001",
  durationSeconds: 96,
  transcript: [
    {
      startSeconds: 0,
      endSeconds: 18,
      text: "Creators should stay present with the audience instead of operating a checklist.",
    },
    {
      startSeconds: 38,
      endSeconds: 58,
      text: "Safe action needs policy, receipts, targeted failure recovery, and duplicate protection.",
    },
  ],
  audienceQuestions: [
    "How do you stop duplicate posts?",
    "What happens if LinkedIn fails?",
    "Which Google model makes the plan?",
    "Can I connect my own publishing accounts?",
  ],
};
const validPlan: CampaignPlan = {
  angle: "Operate the full creator campaign while the creator remains live.",
  hook: "Stay live while Creator Duty handles the surrounding campaign.",
  tone: "calm",
  selectedMoment: {
    startSeconds: 38,
    endSeconds: 53,
    rationale: "This moment explains safe autonomous execution and proof.",
  },
  channels: ["x", "linkedin", "instagram", "youtube_shorts"],
  estimatedModelSpendUsd: 0.05,
};
const validVariants: ChannelVariant[] = [
  {
    channel: "x",
    copy: "Stay live while Creator Duty handles the surrounding campaign.",
    ctaUrl: "https://sigmora.org/creator-duty",
    hashtags: ["#AllThingsAgenticHackathon", "#Gemini", "#GoogleCloud"],
  },
  {
    channel: "linkedin",
    copy: "A live event now becomes a durable, verified creator campaign.",
    ctaUrl: "https://sigmora.org/creator-duty",
    hashtags: ["#AllThingsAgenticHackathon", "#AIAgents", "#CreatorEconomy"],
  },
  {
    channel: "instagram",
    copy: "I stayed with the audience while Creator Duty completed the campaign behind the scenes.",
    ctaUrl: "https://sigmora.org/creator-duty",
    hashtags: ["#AllThingsAgenticHackathon", "#CreatorTools", "#BuildInPublic"],
  },
  {
    channel: "youtube_shorts",
    copy: "One live event. One verified campaign. Zero duplicate posts.",
    ctaUrl: "https://sigmora.org/creator-duty",
    hashtags: ["#AllThingsAgenticHackathon", "#AIAgents"],
  },
];

class StubGoogleClient implements GoogleModelClient {
  public readonly requests: GenerateContentParameters[] = [];

  public constructor(private readonly responses: GenerateContentResponseLike[]) {}

  public async generateContent(
    parameters: GenerateContentParameters,
  ): Promise<GenerateContentResponseLike> {
    this.requests.push(parameters);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No stub response configured.");
    return response;
  }
}

function response(value: unknown): GenerateContentResponseLike {
  return {
    text: JSON.stringify(value),
    responseId: "google_response_001",
    modelVersion: "gemini-3.7-flash-2026-08",
    usageMetadata: {
      promptTokenCount: 101,
      candidatesTokenCount: 47,
      totalTokenCount: 148,
    },
  };
}

describe("DeterministicModelAgent", () => {
  it("reproducibly creates a bounded plan and complete evidence", async () => {
    const model = new DeterministicModelAgent({ now: fixedNow });
    const input = { event, source, maxEstimatedModelSpendUsd: 5 };

    const first = await model.planCampaign(input);
    const second = await model.planCampaign(input);

    expect(first.value).toEqual(second.value);
    expect(first.invocation.responseId).toBe(second.invocation.responseId);
    expect(first.value.selectedMoment).toEqual({
      startSeconds: 38,
      endSeconds: 53,
      rationale: "This moment explains the operational value, safety boundary, and visible proof of action.",
    });
    expect(first.value.channels).toEqual(["x", "linkedin", "instagram", "youtube_shorts"]);
    expect(first.evidence).toMatchObject({
      sdk: "deterministic",
      provider: "deterministic",
      requestedModel: "creator-duty-deterministic-v1",
      resolvedModel: "creator-duty-deterministic-v1",
      finishReason: "DETERMINISTIC",
    });
  });

  it("creates distinct, platform-bounded variants and clusters every question", async () => {
    const model = new DeterministicModelAgent({ now: fixedNow });
    const plan = await model.planCampaign({ event, source, maxEstimatedModelSpendUsd: 5 });
    const variants = await model.draftChannelVariants({
      event,
      source,
      plan: plan.value,
      ctaUrl: "https://sigmora.org/creator-duty",
    });
    const recap = await model.prepareRecap({ event, source, plan: plan.value, variants: variants.value });

    expect(new Set(variants.value.map((item) => item.copy)).size).toBe(4);
    expect(variants.value.find((item) => item.channel === "x")?.copy.length).toBeLessThanOrEqual(280);
    expect(variants.value.find((item) => item.channel === "youtube_shorts")?.copy.length).toBeLessThanOrEqual(100);
    expect(variants.value.every((item) => item.ctaUrl === "https://sigmora.org/creator-duty")).toBe(true);
    expect(recap.value.questionClusters.flatMap((cluster) => cluster.questions).sort()).toEqual(
      [...source.audienceQuestions].sort(),
    );
  });

  it("fails closed when the source cannot contain a 12-second moment", async () => {
    const model = new DeterministicModelAgent({ now: fixedNow });
    await expect(
      model.planCampaign({
        event,
        source: { ...source, durationSeconds: 5 },
        maxEstimatedModelSpendUsd: 5,
      }),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVARIANT" });
  });
});

describe("GeminiModelAgent", () => {
  it("uses the official structured-output request and records exact response evidence", async () => {
    const client = new StubGoogleClient([response(validPlan)]);
    const model = new GeminiModelAgent({
      provider: "gemini_api",
      model: "gemini-3.7-flash",
      client,
      now: fixedNow,
    });

    const result = await model.planCampaign({ event, source, maxEstimatedModelSpendUsd: 5 });
    const request = client.requests[0];

    expect(result.value).toEqual(validPlan);
    expect(result.invocation).toMatchObject({
      purpose: "plan_campaign",
      provider: "gemini_api",
      model: "gemini-3.7-flash",
      responseId: "google_response_001",
      modelVersion: "gemini-3.7-flash-2026-08",
      inputTokens: 101,
      outputTokens: 47,
    });
    expect(result.evidence).toMatchObject({
      sdk: "@google/genai",
      apiSurface: "models.generateContent",
      requestedModel: "gemini-3.7-flash",
      resolvedModel: "gemini-3.7-flash-2026-08",
      responseId: "google_response_001",
      totalTokenCount: 148,
    });
    expect(request?.model).toBe("gemini-3.7-flash");
    expect(request?.config?.responseMimeType).toBe("application/json");
    expect(request?.config?.responseJsonSchema).toBeDefined();
    expect(JSON.stringify(request?.config?.responseJsonSchema)).not.toContain("$schema");
    expect(JSON.stringify(request?.config?.responseJsonSchema)).not.toContain("minLength");
  });

  it("rejects malformed JSON rather than extracting or repairing prose", async () => {
    const client = new StubGoogleClient([
      {
        text: "```json\n{not valid}\n```",
        responseId: "bad_json_001",
        modelVersion: "gemini-3.7-flash-2026-08",
      },
    ]);
    const model = new GeminiModelAgent({
      provider: "gemini_api",
      model: "gemini-3.7-flash",
      client,
      now: fixedNow,
    });

    await expect(
      model.planCampaign({ event, source, maxEstimatedModelSpendUsd: 5 }),
    ).rejects.toMatchObject({ code: "MODEL_INVALID_JSON" });
  });

  it("validates successful channel variants and recap responses independently", async () => {
    const recapValue = {
      headline: "Creator Duty completed the livestream campaign",
      summary:
        "The campaign produced distinct channel releases, preserved receipts, and prepared audience follow-up drafts.",
      questionClusters: [
        {
          theme: "Reliability",
          questions: ["How do you stop duplicate posts?"],
          suggestedAnswer: "Per-target idempotency and receipt lookup prevent a completed post from running twice.",
        },
      ],
    };
    const client = new StubGoogleClient([
      response({ variants: validVariants }),
      { ...response(recapValue), responseId: "google_response_002" },
    ]);
    const model = new GeminiModelAgent({
      provider: "gemini_api",
      model: "gemini-3.7-flash",
      client,
      now: fixedNow,
    });

    const variants = await model.draftChannelVariants({
      event,
      source,
      plan: validPlan,
      ctaUrl: "https://sigmora.org/creator-duty",
    });
    const recap = await model.prepareRecap({
      event: { ...event, eventType: "creator.live.ended" },
      source,
      plan: validPlan,
      variants: variants.value,
    });

    expect(variants.value).toEqual(validVariants);
    expect(variants.invocation.purpose).toBe("draft_channel_variants");
    expect(JSON.stringify(client.requests[0]?.contents)).toContain("Typed policy supplies the authorized channel tags");
    expect(JSON.stringify(client.requests[0]?.config?.responseJsonSchema)).toContain("leading # character");
    expect(recap.value).toEqual(recapValue);
    expect(recap.invocation).toMatchObject({
      purpose: "prepare_recap",
      responseId: "google_response_002",
    });
    expect(client.requests).toHaveLength(2);
  });

  it("replaces model hashtag suggestions with the typed per-channel allowlist", async () => {
    const withoutMarkers = validVariants.map((variant, index) => ({
      ...variant,
      hashtags: variant.hashtags.map((hashtag) =>
        index === 0 ? hashtag.slice(1).replace("AllThings", "All Things-") : hashtag.slice(1),
      ),
    }));
    const client = new StubGoogleClient([response({ variants: withoutMarkers })]);
    const model = new GeminiModelAgent({
      provider: "vertex_ai",
      model: "gemini-3.7-flash",
      client,
      now: fixedNow,
    });

    const result = await model.draftChannelVariants({
      event,
      source,
      plan: validPlan,
      ctaUrl: "https://sigmora.org/creator-duty",
    });

    expect(result.value.map(({ channel, hashtags }) => ({ channel, hashtags }))).toEqual([
      { channel: "x", hashtags: ["#AllThingsAgenticHackathon", "#Gemini", "#GoogleCloud"] },
      { channel: "linkedin", hashtags: ["#AllThingsAgenticHackathon", "#AIAgents", "#CreatorEconomy"] },
      { channel: "instagram", hashtags: ["#AllThingsAgenticHackathon", "#CreatorTools", "#BuildInPublic"] },
      { channel: "youtube_shorts", hashtags: ["#AllThingsAgenticHackathon", "#AIAgents"] },
    ]);
  });

  it("discards unsafe model hashtag content instead of repairing or publishing it", async () => {
    const unsafe = validVariants.map((variant, index) => ({
      ...variant,
      hashtags: index === 0 ? ["bad tag!"] : variant.hashtags,
    }));
    const client = new StubGoogleClient([response({ variants: unsafe })]);
    const model = new GeminiModelAgent({
      provider: "vertex_ai",
      model: "gemini-3.7-flash",
      client,
      now: fixedNow,
    });

    const result = await model.draftChannelVariants({
      event,
      source,
      plan: validPlan,
      ctaUrl: "https://sigmora.org/creator-duty",
    });
    expect(result.value.flatMap(({ hashtags }) => hashtags)).not.toContain("bad tag!");
    expect(result.value.every(({ hashtags }) => hashtags.every((tag) => /^#[A-Za-z0-9_]+$/.test(tag)))).toBe(true);
  });

  it("rejects valid JSON that violates the Zod schema", async () => {
    const client = new StubGoogleClient([response({ ...validPlan, hook: "short" })]);
    const model = new GeminiModelAgent({
      provider: "gemini_api",
      model: "gemini-3.7-flash",
      client,
      now: fixedNow,
    });

    const rejection = model.planCampaign({ event, source, maxEstimatedModelSpendUsd: 5 });
    await expect(rejection).rejects.toBeInstanceOf(ModelAgentError);
    await expect(rejection).rejects.toMatchObject({ code: "MODEL_OUTPUT_SCHEMA" });
  });

  it("rejects a schema-valid response that changes the authorized channel set", async () => {
    const client = new StubGoogleClient([
      response({ variants: validVariants.slice(0, 3) }),
    ]);
    const model = new GeminiModelAgent({
      provider: "vertex_ai",
      model: "gemini-3.5-flash",
      client,
      now: fixedNow,
    });

    await expect(
      model.draftChannelVariants({
        event,
        source,
        plan: validPlan,
        ctaUrl: "https://sigmora.org/creator-duty",
      }),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVARIANT" });
  });

  it("requires response IDs and resolved model versions for evidence", async () => {
    const client = new StubGoogleClient([{ text: JSON.stringify(validPlan) }]);
    const model = new GeminiModelAgent({
      provider: "gemini_api",
      model: "gemini-3.7-flash",
      client,
      now: fixedNow,
    });

    await expect(
      model.planCampaign({ event, source, maxEstimatedModelSpendUsd: 5 }),
    ).rejects.toMatchObject({ code: "MODEL_EVIDENCE_MISSING" });
  });

  it("rejects an ineligible primary model before making a call", () => {
    const client = new StubGoogleClient([]);
    expect(
      () =>
        new GeminiModelAgent({
          provider: "gemini_api",
          model: "gemini-3.1-flash-lite",
          client,
        }),
    ).toThrowError(/3\.5-or-newer/);
  });

  it("requires explicit credentials for the real SDK path", () => {
    expect(
      () =>
        new GeminiModelAgent({
          provider: "gemini_api",
          model: "gemini-3.7-flash",
        }),
    ).toThrowError(/API key/);
    expect(
      () =>
        new GeminiModelAgent({
          provider: "vertex_ai",
          model: "gemini-3.7-flash",
        }),
    ).toThrowError(/project and location/);
  });
});

describe("GemmaCriticAdapter", () => {
  it("returns advisory findings with separate model evidence and no authority field", async () => {
    const client = new StubGoogleClient([
      {
        ...response({
          findings: [
            {
              code: "CLAIM_REVIEW",
              severity: "warning",
              channel: "x",
              message: "The reliability wording should be supported by the measured hero run.",
            },
          ],
        }),
        modelVersion: "gemma-4-26b-a4b-it-2026-08",
      },
    ]);
    const critic = new GemmaCriticAdapter({
      provider: "gemini_api",
      model: "gemma-4-26b-a4b-it",
      client,
      now: fixedNow,
    });

    const result = await critic.critique({
      plan: validPlan,
      variants: validVariants,
      policySummary: "Deterministic validation has not run yet.",
    });

    expect(result.value.model).toBe("gemma-4-26b-a4b-it-2026-08");
    expect(result.value.findings).toHaveLength(1);
    expect(result.value).not.toHaveProperty("approved");
    expect(result.invocation.purpose).toBe("critic");
    expect(client.requests[0]?.model).toBe("gemma-4-26b-a4b-it");
  });

  it("fails closed if the critic tries to add an approval decision", async () => {
    const client = new StubGoogleClient([
      response({ findings: [], approved: true }),
    ]);
    const critic = new GemmaCriticAdapter({
      provider: "gemini_api",
      model: "gemma-4-26b-a4b-it",
      client,
      now: fixedNow,
    });

    await expect(
      critic.critique({
        plan: validPlan,
        variants: validVariants,
        policySummary: "Policy is authoritative.",
      }),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_SCHEMA" });
  });
});

describe("Google response schema projection", () => {
  it("removes unsupported wire constraints while preserving structure", () => {
    const projected = toGoogleResponseJsonSchema({
      $schema: "draft",
      type: "object",
      additionalProperties: false,
      properties: {
        value: { type: "string", minLength: 8, pattern: "^[a-z]+$" },
      },
      required: ["value"],
    });

    expect(projected).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    });
  });
});
