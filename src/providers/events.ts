import { PubSub } from "@google-cloud/pubsub";

import type { CreatorLiveEvent, ProcessResult } from "../domain/types.js";

export interface DispatchReceipt {
  transport: "direct" | "pubsub";
  eventId: string;
  messageId?: string;
  result?: ProcessResult;
}

export interface EventDispatcher {
  dispatch(event: CreatorLiveEvent): Promise<DispatchReceipt>;
}

export class DirectEventDispatcher implements EventDispatcher {
  public constructor(
    private readonly handler: (event: CreatorLiveEvent) => Promise<ProcessResult>,
  ) {}

  public async dispatch(event: CreatorLiveEvent): Promise<DispatchReceipt> {
    const result = await this.handler(event);
    return { transport: "direct", eventId: event.eventId, result };
  }
}

export class PubSubEventDispatcher implements EventDispatcher {
  private readonly pubsub: PubSub;

  public constructor(
    private readonly topicName: string,
    projectId?: string,
  ) {
    this.pubsub = new PubSub(projectId === undefined ? {} : { projectId });
  }

  public async dispatch(event: CreatorLiveEvent): Promise<DispatchReceipt> {
    const messageId = await this.pubsub.topic(this.topicName).publishMessage({
      data: Buffer.from(JSON.stringify(event), "utf8"),
      attributes: {
        eventId: event.eventId,
        eventType: event.eventType,
        creatorId: event.creatorId,
      },
    });
    return { transport: "pubsub", eventId: event.eventId, messageId };
  }
}
