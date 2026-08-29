import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { CreatorLiveEvent, LiveSource } from "../domain/types.js";

const liveSourceSchema = z
  .object({
    sourceClipId: z.string().min(3),
    transcriptId: z.string().min(3),
    durationSeconds: z.number().positive(),
    transcript: z
      .array(
        z
          .object({
            startSeconds: z.number().min(0),
            endSeconds: z.number().positive(),
            text: z.string().min(1).max(5_000),
          })
          .strict(),
      )
      .min(1),
    audienceQuestions: z.array(z.string().min(3).max(500)).max(100),
  })
  .strict();

export interface SourceProvider {
  readonly name: string;
  load(event: CreatorLiveEvent): Promise<LiveSource>;
}

export class FixtureSourceProvider implements SourceProvider {
  public readonly name = "synthetic_fixture";

  public constructor(private readonly fixtureDirectory: string) {}

  public async load(event: CreatorLiveEvent): Promise<LiveSource> {
    const raw = await readFile(path.join(this.fixtureDirectory, "source.json"), "utf8");
    const source = liveSourceSchema.parse(JSON.parse(raw));
    if (
      source.sourceClipId !== event.stream.sourceClipId ||
      source.transcriptId !== event.stream.transcriptId
    ) {
      throw new Error("The named source fixture does not match the event source IDs.");
    }
    return source;
  }
}
