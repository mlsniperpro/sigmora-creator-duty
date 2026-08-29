import { timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";

import type { AppConfig } from "../config.js";

const oidcClient = new OAuth2Client();

export function demoAuthorization(config: AppConfig) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!config.allowDemoTrigger) {
      response.status(404).json({ error: "demo_trigger_disabled" });
      return;
    }
    if (!config.demoApiKey) {
      if (config.nodeEnv === "production") {
        response.status(503).json({ error: "demo_key_not_configured" });
        return;
      }
      next();
      return;
    }

    const supplied = request.header("x-demo-key") ?? extractBearer(request.header("authorization"));
    if (!supplied || !constantTimeEqual(supplied, config.demoApiKey)) {
      response.status(401).json({ error: "invalid_demo_key" });
      return;
    }
    next();
  };
}

export function pubsubAuthorization(config: AppConfig) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (config.allowUnauthenticatedPubsub && config.nodeEnv !== "production") {
      next();
      return;
    }
    if (!config.pubsubAudience || !config.pubsubServiceAccountEmail) {
      response.status(503).json({ error: "pubsub_audience_not_configured" });
      return;
    }
    const token = extractBearer(request.header("authorization"));
    if (!token) {
      response.status(401).json({ error: "missing_pubsub_token" });
      return;
    }

    try {
      const ticket = await oidcClient.verifyIdToken({ idToken: token, audience: config.pubsubAudience });
      if (!isAuthorizedPubsubIdentity(ticket.getPayload(), config.pubsubServiceAccountEmail)) {
        response.status(401).json({ error: "invalid_pubsub_identity" });
        return;
      }
      next();
    } catch {
      response.status(401).json({ error: "invalid_pubsub_token" });
    }
  };
}

export function isAuthorizedPubsubIdentity(
  payload: { email?: string; email_verified?: boolean } | undefined,
  expectedEmail: string,
): boolean {
  return (
    payload?.email_verified === true &&
    typeof payload.email === "string" &&
    constantTimeEqual(payload.email.toLowerCase(), expectedEmail.toLowerCase())
  );
}

function extractBearer(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
