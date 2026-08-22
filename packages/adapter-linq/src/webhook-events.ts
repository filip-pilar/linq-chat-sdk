import type { LinqAPIV3 } from "@linqapp/sdk";

/**
 * How this adapter treats each Linq webhook event.
 *
 * The key type is the SDK's own `WebhookEventType`, so this record must name
 * every event Linq can send. When an `@linqapp/sdk` upgrade adds one, the
 * record is missing a key and **typecheck fails** — the drift surfaces on the
 * bump's own pull request rather than as silence in production.
 *
 * That matters: `@linqapp/sdk` went from 25 event types in 0.22.1 to 44 in
 * 0.40.0. Nineteen events appeared in a single upgrade and nothing noticed.
 *
 * `"handled"` means the adapter acts on the event. `{ ignored }` records a
 * deliberate decision and why, so an unhandled event is a documented choice
 * rather than an oversight.
 */
export type WebhookEventDisposition = "handled" | { readonly ignored: string };

const CHAT_SDK_HAS_NO_PRIMITIVE =
  "No Chat SDK primitive. Reach it through the concrete adapter with " +
  'bot.getAdapter("linq") when needed.';

const NOT_YET_IMPLEMENTED = "Supported by Linq, not yet mapped by this adapter.";

export const WEBHOOK_EVENT_COVERAGE: Record<LinqAPIV3.WebhookEventType, WebhookEventDisposition> = {
  // Inbound conversation — the adapter's core path.
  "message.received": "handled",
  "reaction.added": "handled",
  "reaction.removed": "handled",

  // Message lifecycle. Chat SDK has no delivery-status dispatch, so these
  // surface on the adapter through `onDeliveryStatus`.
  "message.sent": "handled",
  "message.delivered": "handled",
  "message.read": "handled",
  "message.failed": "handled",
  "message.edited": { ignored: NOT_YET_IMPLEMENTED },

  // Membership. `participant.added` maps to ChatInstance.processMemberJoinedChannel.
  "participant.added": { ignored: NOT_YET_IMPLEMENTED },
  "participant.removed": { ignored: NOT_YET_IMPLEMENTED },

  // Chat metadata.
  "chat.created": { ignored: NOT_YET_IMPLEMENTED },
  "chat.group_name_updated": { ignored: NOT_YET_IMPLEMENTED },
  "chat.group_icon_updated": { ignored: NOT_YET_IMPLEMENTED },
  "chat.group_name_update_failed": { ignored: NOT_YET_IMPLEMENTED },
  "chat.group_icon_update_failed": { ignored: NOT_YET_IMPLEMENTED },
  "chat.background_updated": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "chat.typing_indicator.started": { ignored: NOT_YET_IMPLEMENTED },
  "chat.typing_indicator.stopped": { ignored: NOT_YET_IMPLEMENTED },

  // Line health. Relevant to send gating, but not a conversation event.
  "phone_number.status_updated": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },

  // Polls. Linq has a full poll API; Chat SDK has no poll primitive.
  "poll.received": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "poll.sent": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "poll.delivered": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "poll.read": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "poll.failed": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "poll.updated": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "poll.vote.added": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "poll.vote.removed": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "poll.reaction.added": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },

  // Payments. A Linq capability with no messaging-abstraction equivalent.
  "payment.succeeded": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "payment.authorized": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "payment.declined": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "payment.canceled": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "payment.expired": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "connection.created": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "connection.revoked": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },

  // Location sharing.
  "location.sharing.started": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "location.sharing.stopped": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },

  // Voice calls. Not messaging, and only on the early-access API.
  "call.initiated": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "call.ringing": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "call.answered": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "call.ended": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "call.failed": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "call.declined": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
  "call.no_answer": { ignored: CHAT_SDK_HAS_NO_PRIMITIVE },
};

/** Every event this adapter acts on. */
export function handledWebhookEvents(): LinqAPIV3.WebhookEventType[] {
  return (
    Object.entries(WEBHOOK_EVENT_COVERAGE) as [
      LinqAPIV3.WebhookEventType,
      WebhookEventDisposition,
    ][]
  )
    .filter(([, disposition]) => disposition === "handled")
    .map(([event]) => event);
}
