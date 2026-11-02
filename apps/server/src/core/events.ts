import type { EventPayloadMap, EventType, PublicEvent } from "@slackboard/shared";
import { redactObject, truncateUtf8 } from "@slackboard/shared";
import type { EventRepository } from "../db/events.js";

export type EventSubscriber = (event: PublicEvent) => void;

export class EventBus {
  private readonly subscribers = new Set<EventSubscriber>();

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(event: PublicEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // A broken subscriber must not prevent durable delivery to others.
      }
    }
  }
}

export class EventService {
  constructor(
    private readonly repository: EventRepository,
    private readonly bus: EventBus,
    private readonly options: { maxEventBytes: number; redactValues: string[] },
  ) {}

  append<E extends EventType>(input: {
    sessionId: string;
    jobId?: string;
    type: E;
    payload: EventPayloadMap[E];
  }): PublicEvent {
    const redacted = redactObject(input.payload, this.options.redactValues);
    const serialized = JSON.stringify(redacted);
    let payload: EventPayloadMap[E] = redacted;
    if (Buffer.byteLength(serialized, "utf8") > this.options.maxEventBytes) {
      payload = {
        truncated: true,
        preview: truncateUtf8(serialized, this.options.maxEventBytes - 128).text,
      } as unknown as EventPayloadMap[E];
    }
    const event = this.repository.append(
      {
        sessionId: input.sessionId,
        jobId: input.jobId,
        type: input.type,
        payload,
      } as Parameters<EventRepository["append"]>[0],
      new Date().toISOString(),
    );
    this.bus.publish(event);
    return event;
  }

  replay(sessionId: string, afterSeq: number, limit = 500): PublicEvent[] {
    return this.repository.after(sessionId, afterSeq, limit);
  }

  maxSeq(sessionId: string): number {
    return this.repository.maxSeq(sessionId);
  }

  subscribe(subscriber: EventSubscriber): () => void {
    return this.bus.subscribe(subscriber);
  }
}
