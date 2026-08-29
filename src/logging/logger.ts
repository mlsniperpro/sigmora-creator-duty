import type { StructuredLogEntry } from "../domain/types.js";

export interface Logger {
  log(entry: StructuredLogEntry): void;
}

export class JsonLogger implements Logger {
  public log(entry: StructuredLogEntry): void {
    const payload = {
      timestamp: new Date().toISOString(),
      ...entry,
      ...(entry.traceId && process.env.GOOGLE_CLOUD_PROJECT
        ? { "logging.googleapis.com/trace": `projects/${process.env.GOOGLE_CLOUD_PROJECT}/traces/${entry.traceId}` }
        : {}),
    };
    const encoded = JSON.stringify(payload);
    if (entry.severity === "ERROR") {
      process.stderr.write(`${encoded}\n`);
    } else {
      process.stdout.write(`${encoded}\n`);
    }
  }
}

export class MemoryLogger implements Logger {
  public readonly entries: StructuredLogEntry[] = [];

  public log(entry: StructuredLogEntry): void {
    this.entries.push(structuredClone(entry));
  }
}
