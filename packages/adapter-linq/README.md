# @forma/linq-chat-sdk-adapter

A private Forma-maintained Linq adapter for [Chat SDK](https://www.npmjs.com/package/chat).
Linq's published package remains `@linqapp/chat-sdk-adapter`.

## Setup

```ts
import { Chat } from "chat";
import { createLinqAdapter } from "@forma/linq-chat-sdk-adapter";

const linq = createLinqAdapter({
  apiKey: process.env.LINQ_API_KEY!,
  signingSecret: process.env.LINQ_SIGNING_SECRET!,
});

const chat = new Chat({ adapters: { linq } });
export const POST = chat.webhooks.linq;
```

The host must pass the untouched request body to this route. Direct deliveries use Standard
Webhooks (`webhook-id`, `webhook-signature`, and `webhook-timestamp`) with replay checks before
parsing. An explicit `webhookVerifier(request, rawBody)` can authenticate trusted forwarding
instead; it is an exclusive authority and never falls back to a signing secret.

Credentials may rotate:

```ts
const linq = createLinqAdapter({
  credentials: async () => credentialStore.currentLinqCredentials(),
});
```

Lazy credentials resolve once per logical adapter operation. Static API keys expose synchronous
`adapter.client`; every configuration supports `await adapter.getClient()`. Construction enforces
a usable credential and webhook authority even though the released, source-compatible config type
has optional fields. Static direct secrets are validated exactly by `standardwebhooks`; lazy
secrets are validated per request and values are never trimmed.

## Standard Chat SDK behavior

Canonical existing-chat IDs have the form `linq:{chatId}`. The adapter supports ordinary Chat SDK
post, reply, text edit, thread/history/message retrieval, reactions, direct/group typing, chat-wide
mark-read, static cards, files, attachments, buffered streams, and inbound message/reaction
dispatch. Returned message/thread identities are canonical and raw Linq facts remain available.

History is backward-only. Truthful rows are stably oldest-first by the complete RFC3339 provider
instant, including precision beyond JavaScript milliseconds; exact ties preserve provider order.
Rows missing required identity, authorship, or time facts are omitted without losing usable
siblings. Traversal skips at most ten consecutive all-filtered pages and stops on repeated cursors.

Outbound media supports public HTTPS references and caller-supplied bytes. Adapter-performed
uploads reject redirects, embedded credentials, localhost names, and literal loopback,
unspecified, private, link-local, carrier-grade NAT, benchmarking, multicast, and mapped
equivalents, and time out after 30 seconds. DNS resolution and Linq-issued upload-host integrity
remain provider/host-network concerns. Cleanup is limited to resources definitely orphaned before
send submission. Inbound attachments keep stable Linq identity and fetch a fresh download URL when
`fetchData()` runs.

### Proactive direct messages

Released `openDM(handle)` returns a deterministic pending bootstrap because Linq cannot create an
empty chat. Continue from the canonical identity returned by the first accepted post:

```ts
const pendingId = await linq.openDM("+15551234567");
const sent = await chat.thread(pendingId).post("Hello");
const canonicalThread = chat.thread(sent.threadId);
```

The pending `Thread` is immutable and is not migrated. Linq owns chat creation/reuse and delivery;
the adapter does not add locks, persistence, or uncertain-send retries.

## Linq message options and mentions

Use `linqMessage()` for documented provider semantics that standard Chat SDK cannot express:

```ts
import { linqMessage } from "@forma/linq-chat-sdk-adapter";

await thread.post(
  linqMessage("Important", {
    preferredService: "iMessage",
    effect: { type: "screen", name: "confetti" },
  }),
);
```

Its immutable options cover supported services, effects, manual UTF-16 decorations, one native
group mention, and a standalone HTTPS rich link. One compiler renders raw text, supported
Markdown/AST styles, static-card fallback text, and send options. Contradictory input fails before
UUID generation, attachment preparation, logging, or provider I/O.

Use the standard Chat SDK mention token for existing-group posts and replies:

```ts
await groupThread.post(`Please review this, ${groupThread.mentionUser(participantId)}`);
```

Mention-like syntax accepts exactly one complete `<@target>` token. A stable Linq participant ID
is resolved once against that group and must identify one current member with a valid handle; a
phone/email handle requires no lookup. Provider identity remains `Message.author.userId`, while
the handle remains `userName` and the native mention target. Explicit display-text control uses
UTF-16 `[start, end)` offsets:

```ts
await groupThread.post(
  linqMessage("Hey Kevin, can you confirm?", {
    mention: { handle: "+14155551234", range: [4, 9] },
  }),
);
```

Mentions cannot share their text part with manual decorations or a rich link. Derived formatting
may degrade to plain text to preserve the mention. RCS/SMS intent is accepted, but recipient
presentation remains provider/device-owned. RCS/SMS cannot combine with iMessage-only effects,
animations, or manual decorations.

## Conversation-scoped Linq extensions

`adapter.conversation(threadOrId)` accepts a canonical ID or a Chat SDK `Thread`:

```ts
const conversation = linq.conversation(thread);

await conversation.replyToPart(messageId, 0, "part-specific reply");
await conversation.addReaction(messageId, "love", { partIndex: 2 });
await conversation.removeReaction(messageId, "love", { partIndex: 2 });
await conversation.stopTyping();
await conversation.shareContactCard();

const memo = await conversation.sendVoiceMemo({
  url: "https://cdn.example.com/memo.m4a",
});
// An existing Linq attachment ID is also accepted:
// await conversation.sendVoiceMemo({ attachmentId });

await conversation.group.update({ displayName: "Team" });
await conversation.group.addParticipant("+15551234567");
await conversation.group.removeParticipant("+15551234567");
await conversation.group.leave();

await conversation.location.request();
const locations = await conversation.location.retrieve();

const poll = await conversation.polls.create({ options: ["Tacos", "Sushi"] });
await conversation.polls.addOptions(poll.messageId, ["Pizza"]);
await conversation.polls.vote(poll.messageId, {
  optionId: poll.options[0]!.optionId,
  operation: "add",
});
const currentPoll = await conversation.polls.retrieve(poll.messageId);
```

Ordinary replies, whole-message reactions, start-typing, and mark-read stay on standard Chat SDK
APIs. Facade acknowledgements and immutable snapshots expose only validated current provider facts,
not delivery, consent, presentation, request/event correlation, or workflow completion. Poll
create owns one idempotency key; non-idempotent add/vote calls disable SDK retries.

Inbound voice memos are ordinary audio attachments because the current schema does not distinguish
them reliably from other audio. Inbound `text/vcard` parts are ordinary downloadable file
attachments. Transcription, vCard parsing, contact identity, and address-book mutation belong to
the application. `shareContactCard()` is Linq's separate configured Name and Photo Sharing action.

## Verified Linq events

`Chat.webhooks.linq` is the primary integration. Advanced consumers can also use:

- `onLinqEvent(name | names, handler)` for current named events, or
  `onLinqEvent(handler)` for every verified lossless observation;
- `verifyWebhook(request)` and `dispatchVerifiedWebhook(verified, options)` for the branded
  same-adapter verification/dispatch seam;
- released `onDeliveryStatus(listener)` as a compatibility projection of authenticated lifecycle
  facts.

```ts
const unsubscribe = linq.onLinqEvent(["message.delivered", "message.failed"], (event) => {
  console.log(event.type, event.data.providerMessageId, event.rawEvent);
});
```

Verification preserves immutable envelope, raw event, exact text, and bytes. Valid curated events
reach typed named and generic handlers. Canonical events without a curated model reach their exact
named handler with raw data; malformed curated and unknown/future events remain generic/lossless
only. No incompatible standard handler is guessed. Atomic event dedupe, callback isolation,
listener snapshots, fast acknowledgement, and Chat SDK `waitUntil` integration share one verified
pipeline. All nine current poll event families use this pipeline; there is no separate poll
registry or polling workflow.

This seam is not a durable queue. Hosts own HTTP limits and request lifecycle; applications own
persistence and long-running work.

## Native client, compatibility, and boundaries

Use `adapter.client` (static credentials) or `await adapter.getClient()` (all configurations) for
account, subscription, administrative, background, and other provider-native operations. Current
background guidance mentions `glitter`, while the installed SDK/request schema exposes `sky`,
`water`, and `aurora`; no adapter wrapper freezes that discrepancy.

The adapter emits only `linq:{chatId}` and decode-only supports persisted
`linq:{chatId}:dm/group` values. Released `adapter.markRead(threadId, messageId)` remains an alias
of the preferred `Thread.markAsRead()` chat-wide acknowledgement.

Provider failures use Chat SDK's shared error taxonomy while preserving supported Linq code, trace
ID, retry-after, and cause data. Provider success responses are checked only for facts needed to
build public results. Once a mutation may have been accepted, the adapter neither retries nor
performs preparation cleanup.

The adapter does not own provider delivery/ordering, account policy, capability probes, queues,
databases, polling, transcription, retention, deployment, application identity/workflows, or
AI-agent tools and authorization. See [FEATURE_PARITY.md](FEATURE_PARITY.md) for status/evidence and
the repository [scope](../../scope.md) for the ownership boundary.

## Development

The peer floor is Chat SDK `4.38`; the adapter-level `reply()` and `markAsRead()` hooks are absent
from released `4.28.1` declarations/runtime.

```bash
pnpm --filter @forma/linq-chat-sdk-adapter test
pnpm --filter @forma/linq-chat-sdk-adapter typecheck
pnpm --filter @forma/linq-chat-sdk-adapter lint
pnpm --filter @forma/linq-chat-sdk-adapter format:check
pnpm --filter @forma/linq-chat-sdk-adapter build
pnpm --filter @forma/linq-chat-sdk-adapter openapi:check
```

The OpenAPI check covers only the canonical webhook event enum backing the public named-event type.
