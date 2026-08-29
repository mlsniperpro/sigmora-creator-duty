import {
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";
import { z } from "zod";

import { newId } from "../domain/ids.js";
import type { ModelInvocation } from "../domain/types.js";
import { ModelAgentError } from "./errors.js";
import type {
  ModelCallResult,
  ModelEvidence,
  RecordedModelInvocation,
} from "./types.js";

export type GoogleModelProvider = "gemini_api" | "vertex_ai";

export interface GenerateContentResponseLike {
  readonly text?: string | undefined;
  readonly responseId?: string | undefined;
  readonly modelVersion?: string | undefined;
  readonly candidates?: GenerateContentResponse["candidates"] | undefined;
  readonly promptFeedback?: GenerateContentResponse["promptFeedback"] | undefined;
  readonly usageMetadata?: GenerateContentResponse["usageMetadata"] | undefined;
}

export interface GoogleModelClient {
  generateContent(parameters: GenerateContentParameters): Promise<GenerateContentResponseLike>;
}

export interface GoogleClientOptions {
  provider: GoogleModelProvider;
  apiKey?: string;
  project?: string;
  location?: string;
  client?: GoogleModelClient;
}

export interface StructuredGenerationInput<T> {
  client: GoogleModelClient;
  provider: GoogleModelProvider;
  model: string;
  purpose: ModelInvocation["purpose"];
  systemInstruction: string;
  prompt: string;
  jsonSchema: unknown;
  outputSchema: z.ZodType<T>;
  thinkingLevel?: ThinkingLevel;
  maxOutputTokens?: number;
  now: () => Date;
  validate?: (value: T) => void;
}

const UNSUPPORTED_GOOGLE_SCHEMA_KEYS = new Set([
  "$schema",
  "additionalProperties",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxItems",
  "maximum",
  "maxLength",
  "minItems",
  "minimum",
  "minLength",
  "pattern",
]);

/**
 * Google accepts a deliberately small JSON Schema subset. Runtime Zod parsing
 * remains the source of truth for every constraint removed from this wire form.
 */
export function toGoogleResponseJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGoogleResponseJsonSchema);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !UNSUPPORTED_GOOGLE_SCHEMA_KEYS.has(key))
      .map(([key, child]) => [key, toGoogleResponseJsonSchema(child)]),
  );
}

export function createGoogleModelClient(options: GoogleClientOptions): GoogleModelClient {
  if (options.client !== undefined) return options.client;

  if (options.provider === "gemini_api") {
    if (!options.apiKey?.trim()) {
      throw new ModelAgentError(
        "MODEL_CONFIGURATION_INVALID",
        "Gemini API model provider requires a non-empty API key.",
      );
    }
    const sdk = new GoogleGenAI({ apiKey: options.apiKey });
    return {
      generateContent: (parameters) => sdk.models.generateContent(parameters),
    };
  }

  if (!options.project?.trim() || !options.location?.trim()) {
    throw new ModelAgentError(
      "MODEL_CONFIGURATION_INVALID",
      "Vertex AI model provider requires an explicit project and location.",
    );
  }
  const sdk = new GoogleGenAI({
    vertexai: true,
    project: options.project,
    location: options.location,
  });
  return {
    generateContent: (parameters) => sdk.models.generateContent(parameters),
  };
}

export function assertEligiblePrimaryGeminiModel(model: string): void {
  const match = /^gemini-(\d+)\.(\d+)-[a-z0-9][a-z0-9.-]*$/i.exec(model);
  if (match === null) {
    throw new ModelAgentError(
      "MODEL_INELIGIBLE",
      `Primary model must be an exact Gemini 3.5-or-newer model ID; received ${model}.`,
      { model },
    );
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 3 || (major === 3 && minor < 5)) {
    throw new ModelAgentError(
      "MODEL_INELIGIBLE",
      `Primary model ${model} does not satisfy the Gemini 3.5-or-newer requirement.`,
      { model },
    );
  }
}

export function assertGemmaModel(model: string): void {
  if (!/^gemma-[a-z0-9][a-z0-9.-]*$/i.test(model)) {
    throw new ModelAgentError(
      "MODEL_CONFIGURATION_INVALID",
      `Gemma critic requires an exact Gemma model ID; received ${model}.`,
      { model },
    );
  }
}

export async function generateStructuredOutput<T>(
  input: StructuredGenerationInput<T>,
): Promise<ModelCallResult<T>> {
  const response = await input.client.generateContent({
    model: input.model,
    contents: [{ role: "user", parts: [{ text: input.prompt }] }],
    config: {
      systemInstruction: input.systemInstruction,
      responseMimeType: "application/json",
      responseJsonSchema: toGoogleResponseJsonSchema(input.jsonSchema),
      maxOutputTokens: input.maxOutputTokens ?? 4_096,
      ...(input.thinkingLevel === undefined
        ? {}
        : {
            thinkingConfig: {
              thinkingLevel: input.thinkingLevel,
              includeThoughts: false,
            },
          }),
    },
  });

  const responseId = requiredEvidence(response.responseId, "responseId", input);
  const resolvedModel = requiredEvidence(response.modelVersion, "modelVersion", input);
  const recordedAt = input.now().toISOString();
  const finishReason = String(response.candidates?.[0]?.finishReason ?? "UNKNOWN");
  const evidence = createEvidence(input, response, {
    responseId,
    resolvedModel,
    recordedAt,
    finishReason,
  });

  let text: string;
  try {
    text = response.text?.trim() ?? "";
  } catch (cause) {
    throw new ModelAgentError(
      "MODEL_EMPTY_RESPONSE",
      `Model ${input.model} returned no usable structured response.`,
      { model: input.model, purpose: input.purpose, cause },
    );
  }
  if (text.length === 0) {
    const blocked = response.promptFeedback?.blockReason;
    const suffix = blocked === undefined ? "" : ` Block reason: ${String(blocked)}.`;
    throw new ModelAgentError(
      "MODEL_EMPTY_RESPONSE",
      `Model ${input.model} returned an empty structured response.${suffix}`,
      { model: input.model, purpose: input.purpose },
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    throw new ModelAgentError(
      "MODEL_INVALID_JSON",
      `Model ${input.model} returned malformed JSON for ${input.purpose}.`,
      { model: input.model, purpose: input.purpose, cause },
    );
  }

  const parsed = input.outputSchema.safeParse(decoded);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    );
    throw new ModelAgentError(
      "MODEL_OUTPUT_SCHEMA",
      `Model ${input.model} violated the ${input.purpose} output schema.`,
      { model: input.model, purpose: input.purpose, issues },
    );
  }

  if (input.validate !== undefined) input.validate(parsed.data);

  const invocation: RecordedModelInvocation = {
    invocationId: newId("minv"),
    purpose: input.purpose,
    model: input.model,
    provider: input.provider,
    responseId,
    modelVersion: resolvedModel,
    createdAt: recordedAt,
    ...(response.usageMetadata?.promptTokenCount === undefined
      ? {}
      : { inputTokens: response.usageMetadata.promptTokenCount }),
    ...(response.usageMetadata?.candidatesTokenCount === undefined
      ? {}
      : { outputTokens: response.usageMetadata.candidatesTokenCount }),
  };

  return { value: parsed.data, invocation, evidence };
}

function requiredEvidence<T>(
  value: T | null | undefined,
  field: "responseId" | "modelVersion",
  input: Pick<StructuredGenerationInput<unknown>, "model" | "purpose">,
): T {
  if (value === undefined || value === null || value === "") {
    throw new ModelAgentError(
      "MODEL_EVIDENCE_MISSING",
      `Model ${input.model} response omitted required evidence field ${field}.`,
      { model: input.model, purpose: input.purpose },
    );
  }
  return value;
}

function createEvidence<T>(
  input: StructuredGenerationInput<T>,
  response: GenerateContentResponseLike,
  required: {
    responseId: string;
    resolvedModel: string;
    recordedAt: string;
    finishReason: string;
  },
): ModelEvidence {
  return {
    sdk: "@google/genai",
    apiSurface: "models.generateContent",
    provider: input.provider,
    requestedModel: input.model,
    resolvedModel: required.resolvedModel,
    responseId: required.responseId,
    finishReason: required.finishReason,
    recordedAt: required.recordedAt,
    ...(response.usageMetadata?.promptTokenCount === undefined
      ? {}
      : { promptTokenCount: response.usageMetadata.promptTokenCount }),
    ...(response.usageMetadata?.candidatesTokenCount === undefined
      ? {}
      : { candidatesTokenCount: response.usageMetadata.candidatesTokenCount }),
    ...(response.usageMetadata?.totalTokenCount === undefined
      ? {}
      : { totalTokenCount: response.usageMetadata.totalTokenCount }),
  };
}
