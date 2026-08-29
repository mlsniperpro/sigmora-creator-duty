import type { ModelInvocation } from "../domain/types.js";

export type ModelAgentErrorCode =
  | "MODEL_CONFIGURATION_INVALID"
  | "MODEL_EMPTY_RESPONSE"
  | "MODEL_EVIDENCE_MISSING"
  | "MODEL_INELIGIBLE"
  | "MODEL_INVALID_JSON"
  | "MODEL_OUTPUT_INVARIANT"
  | "MODEL_OUTPUT_SCHEMA";

export interface ModelAgentErrorContext {
  model?: string;
  purpose?: ModelInvocation["purpose"];
  issues?: string[];
  cause?: unknown;
}

/** A stable, redacted failure suitable for logs and persisted step state. */
export class ModelAgentError extends Error {
  public readonly code: ModelAgentErrorCode;
  public readonly model?: string;
  public readonly purpose?: ModelInvocation["purpose"];
  public readonly issues: string[];

  public constructor(
    code: ModelAgentErrorCode,
    message: string,
    context: ModelAgentErrorContext = {},
  ) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = "ModelAgentError";
    this.code = code;
    this.issues = context.issues ?? [];
    if (context.model !== undefined) this.model = context.model;
    if (context.purpose !== undefined) this.purpose = context.purpose;
  }
}
