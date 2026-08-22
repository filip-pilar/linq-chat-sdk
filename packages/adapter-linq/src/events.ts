import { LINQ_KNOWN_EVENT_TYPES, type LinqKnownEventType } from "./linq-event-types.generated.js";
import type {
  LinqMessageEditedEventData,
  LinqMessageFailedEventData,
  LinqMessageLifecycleEventData,
  LinqMessageReceivedWebhookData,
  LinqPollFailedEventData,
  LinqPollReceivedEventData,
  LinqPollReceiptEventData,
  LinqPollUpdatedEventData,
  LinqPollVoteEventData,
  LinqLocationSharingStartedEventData,
  LinqLocationSharingStoppedEventData,
  LinqReactionWebhookData,
  LinqWebhookEnvelopeObservation,
  LinqWebhookRawEvent,
  LinqWebhookRawValue,
  LinqWebhookTransportObservation,
  LinqVerifiedWebhook,
} from "./webhook.js";

export interface LinqEventBase<TType extends string, TData> {
  readonly type: TType;
  readonly data: TData;
  readonly envelope: LinqWebhookEnvelopeObservation;
  readonly transport: LinqWebhookTransportObservation;
  readonly rawEvent: LinqWebhookRawEvent;
}

type LinqReactionEventType = "reaction.added" | "reaction.removed";

type LinqMessageLifecycleEventType = "message.sent" | "message.delivered" | "message.read";
type LinqPollReceiptEventType = "poll.sent" | "poll.delivered" | "poll.read";
type LinqPollVoteEventType = "poll.vote.added" | "poll.vote.removed";

type LinqEventData<TType extends LinqKnownEventType> = TType extends "message.received"
  ? LinqMessageReceivedWebhookData
  : TType extends LinqMessageLifecycleEventType
    ? LinqMessageLifecycleEventData
    : TType extends "message.failed"
      ? LinqMessageFailedEventData
      : TType extends "message.edited"
        ? LinqMessageEditedEventData
        : TType extends LinqReactionEventType
          ? LinqReactionWebhookData
          : TType extends "location.sharing.started"
            ? LinqLocationSharingStartedEventData
            : TType extends "location.sharing.stopped"
              ? LinqLocationSharingStoppedEventData
              : TType extends "poll.received"
                ? LinqPollReceivedEventData
                : TType extends LinqPollReceiptEventType
                  ? LinqPollReceiptEventData
                  : TType extends "poll.updated"
                    ? LinqPollUpdatedEventData
                    : TType extends "poll.failed"
                      ? LinqPollFailedEventData
                      : TType extends LinqPollVoteEventType
                        ? LinqPollVoteEventData
                        : TType extends "poll.reaction.added"
                          ? LinqReactionWebhookData
                          : LinqWebhookRawValue;

export type LinqEventMap = {
  readonly [TType in LinqKnownEventType]: LinqEventBase<TType, LinqEventData<TType>>;
};

export type LinqKnownEvent = LinqEventMap[LinqKnownEventType];

/** A verified event name or payload introduced after this adapter version. */
export type LinqFutureEvent = LinqEventBase<string, LinqWebhookRawValue>;

export type LinqAnyEvent = LinqKnownEvent | LinqFutureEvent;

export type LinqEventHandler<TEvent extends LinqAnyEvent = LinqAnyEvent> = (
  event: TEvent,
) => void | Promise<void>;

type RegisteredHandler = LinqEventHandler<LinqAnyEvent>;

interface LinqEventRegistration {
  readonly handler: RegisteredHandler;
  readonly types: readonly LinqKnownEventType[] | null;
}

const KNOWN_EVENT_TYPES = new Set<string>(LINQ_KNOWN_EVENT_TYPES);

export function isLinqKnownEventType(value: string): value is LinqKnownEventType {
  return KNOWN_EVENT_TYPES.has(value);
}

export function createLinqEvent(webhook: LinqVerifiedWebhook): LinqAnyEvent {
  const data =
    webhook.kind === "message.sent" ||
    webhook.kind === "message.delivered" ||
    webhook.kind === "message.read"
      ? webhook.lifecycle
      : webhook.kind === "message.failed"
        ? webhook.failure
        : webhook.kind === "message.edited"
          ? webhook.edit
          : webhook.kind === "location.sharing.started" ||
              webhook.kind === "location.sharing.stopped"
            ? webhook.locationSharing
            : webhook.kind === "poll.received" ||
                webhook.kind === "poll.sent" ||
                webhook.kind === "poll.delivered" ||
                webhook.kind === "poll.read" ||
                webhook.kind === "poll.updated" ||
                webhook.kind === "poll.failed" ||
                webhook.kind === "poll.vote.added" ||
                webhook.kind === "poll.vote.removed"
              ? webhook.poll
              : (webhook.rawEvent.data ?? null);

  return Object.freeze({
    type: webhook.envelope.eventType,
    data,
    envelope: webhook.envelope,
    transport: webhook.transport,
    rawEvent: webhook.rawEvent,
  }) as LinqAnyEvent;
}

/** Instance-local callback registry for verified Linq event dispatch. */
export class LinqEventRegistry {
  private readonly all = new Set<LinqEventRegistration>();
  private readonly byType = new Map<LinqKnownEventType, Set<LinqEventRegistration>>();

  subscribe(types: readonly LinqKnownEventType[] | null, handler: RegisteredHandler): () => void {
    const normalizedTypes = types === null ? null : [...new Set(types)];

    if (normalizedTypes?.length === 0) {
      throw new TypeError("onLinqEvent requires at least one event type");
    }

    const registration: LinqEventRegistration = Object.freeze({
      handler,
      types: normalizedTypes === null ? null : Object.freeze(normalizedTypes),
    });

    if (normalizedTypes === null) {
      this.all.add(registration);
    } else {
      for (const type of normalizedTypes) {
        let registrations = this.byType.get(type);

        if (!registrations) {
          registrations = new Set();
          this.byType.set(type, registrations);
        }

        registrations.add(registration);
      }
    }

    let subscribed = true;

    return () => {
      if (!subscribed) {
        return;
      }

      subscribed = false;
      if (registration.types === null) {
        this.all.delete(registration);
        return;
      }

      for (const type of registration.types) {
        const registrations = this.byType.get(type);
        registrations?.delete(registration);
        if (registrations?.size === 0) {
          this.byType.delete(type);
        }
      }
    };
  }

  handlersFor(type: string, includeNamed = true): readonly RegisteredHandler[] {
    const handlers = [...this.all].map((registration) => registration.handler);

    if (includeNamed && isLinqKnownEventType(type)) {
      for (const registration of this.byType.get(type) ?? []) {
        handlers.push(registration.handler);
      }
    }

    return handlers;
  }
}

export type { LinqKnownEventType } from "./linq-event-types.generated.js";
