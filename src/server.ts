import { setMaxListeners } from "node:events";

import { createApp } from "./app.js";
import { bootstrap, type CreatorDutyRuntime } from "./bootstrap.js";

async function main(): Promise<void> {
  // Google Cloud Storage's retryable PassThrough stack legitimately installs
  // more than Node's default ten listeners during stream construction. Keep a
  // finite process-wide ceiling so constructor-time warnings remain meaningful.
  setMaxListeners(32);
  const runtime = await bootstrap();
  const app = createApp(runtime);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listener = app.listen(runtime.config.port, () => resolve(listener));
    listener.once("error", reject);
  });

  runtime.logger.log({
    severity: "INFO",
    message: "creator-duty server listening",
    model: runtime.system.primaryModel,
    outcome: "ready",
    metadata: {
      port: runtime.config.port,
      environment: runtime.system.environment,
      eventTransport: runtime.system.eventTransport,
      modelProvider: runtime.system.modelProvider,
      mediaProvider: runtime.system.mediaProvider,
      publishProvider: runtime.system.publishProvider,
    },
  });

  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    closing ??= closeServer(server, runtime);
    return closing;
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

async function closeServer(
  server: ReturnType<ReturnType<typeof createApp>["listen"]>,
  runtime: CreatorDutyRuntime,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  await runtime.close();
}

void main().catch(() => {
  process.stderr.write(`${JSON.stringify({
    severity: "ERROR",
    message: "creator-duty server failed to start",
    outcome: "startup_failed",
  })}\n`);
  process.exitCode = 1;
});
