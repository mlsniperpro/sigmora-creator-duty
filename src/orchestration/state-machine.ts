import type { CampaignRecord, CampaignStage } from "../domain/types.js";

const ALLOWED_TRANSITIONS: Readonly<Record<CampaignStage, readonly CampaignStage[]>> = {
  received: ["planning", "recapping", "blocked", "exception"],
  planning: ["producing", "exception"],
  producing: ["validating", "exception"],
  validating: ["publishing", "blocked", "exception"],
  publishing: ["verifying", "exception"],
  verifying: ["publishing", "complete", "exception"],
  complete: ["recapping"],
  recapping: ["closed", "exception"],
  closed: [],
  blocked: [],
  exception: ["planning", "producing", "validating", "publishing", "verifying", "recapping"],
};

export function canTransition(from: CampaignStage, to: CampaignStage): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionCampaign(campaign: CampaignRecord, to: CampaignStage, at = new Date()): CampaignRecord {
  if (!canTransition(campaign.stage, to)) {
    throw new Error(`Illegal campaign transition: ${campaign.stage} -> ${to}`);
  }
  const timestamp = at.toISOString();
  return {
    ...campaign,
    stage: to,
    updatedAt: timestamp,
    ...(to === "planning" && campaign.startedAt === undefined ? { startedAt: timestamp } : {}),
    ...(to === "complete" ? { completedAt: timestamp } : {}),
    ...(to === "closed" ? { closedAt: timestamp } : {}),
  };
}

export function assertPublishableStage(stage: CampaignStage): void {
  if (stage !== "publishing" && stage !== "verifying") {
    throw new Error(`Publishing side effects are forbidden while campaign stage is ${stage}.`);
  }
}
