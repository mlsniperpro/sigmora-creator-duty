# Model and framework evidence

## Primary model

The production model is exactly `gemini-3.7-flash`. The production provider is
Vertex AI at location `global`. Google lists this model as generally available,
with structured output and low, medium, and high thinking levels.

The repository pins the official Google GenAI SDK package:

```json
"@google/genai": "2.19.0"
```

The adapter creates `GoogleGenAI` with `vertexai: true`, an explicit project and
location, and invokes `sdk.models.generateContent`. Gemini API key mode exists
for development, but the Cloud Run deployment uses its service identity and
Vertex AI rather than a stored Gemini API key.

## Evidence record

Every real structured call must preserve:

```text
sdk
apiSurface
provider
requestedModel
resolvedModel
responseId
finishReason
recordedAt
promptTokenCount
candidatesTokenCount
totalTokenCount
```

Token fields are recorded when the service returns them. Requested model,
resolved model, and response ID are mandatory; an adapter response missing them
is rejected instead of being presented as eligible evidence.

## Bounded uses

The primary model performs three typed jobs:

1. select a promotional moment and campaign plan from the named synthetic live
   source;
2. draft distinct variants for the exact authorized channels and CTA; and
3. prepare the post-live recap and question clusters.

The model does not claim events, transition state, validate release authority,
construct provider credentials, or publish. Runtime Zod schemas and additional
source/channel checks reject malformed or authority-expanding output.

## Deterministic provider

The local deterministic provider implements the same model interface and emits
fixture evidence with provider `deterministic`. It is used for tests and the
one-command judge demo. Its records must never be shown as Vertex AI or Gemini
proof.

## Optional models

The repository contains disabled adapters for `veo-3.1-generate-preview` and
`lyria-3-clip-preview`, both exact IDs documented by Google. An implemented but
unexercised adapter earns no claim. Until a real completed operation is stored
with its exact model, operation ID, prompt, artifact, and timestamp, submission
copy must describe the model as disabled and not yet evidenced.

Gemma support has no default ID. An operator must set an exact currently
supported `GEMMA_MODEL`, exercise the critic, and retain its invocation/result
before making any integration claim. Deterministic policy remains authoritative
even when the critic is enabled.

## Primary references

- [Gemini 3.7 Flash model](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash)
- [Google GenAI SDK on Vertex AI](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/quickstart)
- [Veo 3.1 model](https://ai.google.dev/gemini-api/docs/models/veo-3.1-generate-preview)
- [Lyria 3 generation](https://ai.google.dev/gemini-api/docs/music-generation)
