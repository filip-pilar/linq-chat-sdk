# @forma/linq-chat-sdk-adapter

A Linq adapter for [Chat SDK](https://www.npmjs.com/package/chat). It implements ordinary Chat SDK
behavior for existing Linq chats and exposes a deliberately small Linq-specific extension surface.

## Setup

```ts
import { Chat } from "chat";
import { createLinqAdapter } from "@forma/linq-chat-sdk-adapter";

const linq = createLinqAdapter({
  apiKey: process.env.LINQ_API_KEY!,
  signingSecret: process.env.LINQ_SIGNING_SECRET!, // Standard Webhooks whsec_ secret
});

const chat = new Chat({ adapters: { linq } });
export const POST = chat.webhooks.linq;
```

The host must pass the untouched request body to the route. The adapter verifies the
`webhook-id`, `webhook-signature`, and `webhook-timestamp` headers and enforces the Standard
Webhooks replay window before parsing or dispatching.

## Standard Chat SDK behavior

For canonical Linq thread IDs (`linq:{chatId}`), the adapter supports:

- posting and replying with text, Markdown/AST content, static cards, files, and attachments;
- editing text, fetching thread/history/message data, and backward pagination;
- whole-message reactions, typing, and chat-wide mark-read acknowledgements;
- inbound message and reaction dispatch through the ordinary Chat SDK handlers;
- canonical returned thread/message identities and lossless Linq raw message data.

Outbound media accepts safe public HTTPS references or caller-supplied bytes. Provider upload URLs
are validated and cannot redirect. Preparation-only attachment cleanup is best effort; uncertain
send recovery, retention, and deletion policy are not adapter workflows. Inbound attachments retain
a stable Linq attachment ID and resolve a fresh downloadable URL when `fetchData()` runs.

History parsing isolates malformed/null/unknown parts and tombstones so usable siblings remain
available. Backward traversal skips at most ten consecutive all-filtered provider pages and stops
on repeated cursors. Forward history is not claimed.

## Linq message options

Use `linqMessage(content, options)` when a provider-specific message semantic is required:

```ts
import { linqMessage } from "@forma/linq-chat-sdk-adapter";

await thread.post(
  linqMessage("Important", {
    preferredService: "iMessage",
    effect: { type: "screen", name: "confetti" },
  }),
);
```

The immutable options snapshot supports documented preferred services, bubble/screen effects,
validated text decorations, and standalone native rich links. The compiler produces deterministic
plain text and UTF-16 decoration ranges from raw text, supported Markdown/AST styles, and applicable
static-card text. Invalid or contradictory inputs fail before UUID generation, attachment
preparation, logging, or provider I/O.

Explicit RCS or SMS intent cannot be combined with Linq-only effects, animations, or manual
decorations. Omitted service remains provider best-effort. This contract describes the request sent
to Linq, not recipient-device presentation.

## Narrow Linq conversation extensions

`adapter.conversation(threadOrId)` accepts a canonical Linq thread ID or Chat SDK `Thread` and
provides semantics the standard surface cannot express faithfully:

```ts
const conversation = linq.conversation(thread);

await conversation.replyToPart(messageId, 0, "part-specific reply");
await conversation.addReaction(messageId, "love", { partIndex: 2 });
await conversation.removeReaction(messageId, "love", { partIndex: 2 });

await conversation.stopTyping();
await conversation.shareContactCard();
await conversation.sendVoiceMemo({ url: "https://cdn.example.com/memo.m4a" });
await conversation.sendVoiceMemo({ attachmentId });

await conversation.group.update({ displayName: "Team" });
await conversation.group.addParticipant("+15551234567");
await conversation.group.removeParticipant("+15551234567");
await conversation.group.leave();

await conversation.location.request();
const snapshot = await conversation.location.retrieve();
```

Ordinary replies, reactions, start-typing, and mark-read remain standard Chat SDK operations.
Group/location/voice-memo results expose only facts established by the provider response; they do
not imply delivery, consent, correlation, playback, presentation, or workflow completion.

Inbound user voice memos arrive through the standard media path as downloadable audio attachments.
The current canonical schema does not reliably distinguish a native Messages voice memo from an
ordinary audio attachment, so the adapter does not invent a discriminator. Transcription belongs
to the consuming application.

## Verified Linq events

The ordinary `Chat.webhooks.linq` route is the primary integration. For consumers that need Linq
facts beyond standard message/reaction handlers, the adapter also exposes:

- `onLinqEvent(name | names | "*", handler)` for typed current events and lossless generic events;
- `verifyWebhook(request)` for a branded verified observation without dispatch;
- `dispatchVerifiedWebhook(verified, options)` for dispatching only a result produced by the same
  adapter instance.

```ts
const unsubscribe = linq.onLinqEvent(["message.delivered", "message.failed"], async (event) => {
  console.log(event.type, event.data.providerMessageId, event.rawEvent);
});
```

Verification preserves immutable envelope, transport, normalized observations, `rawEvent`, exact
raw text, and raw bytes. Current known events have typed discriminants; unknown/future Standard
Webhook events remain lossless and are acknowledged without being forced through an incompatible
standard handler. Generic callbacks are failure-isolated and participate in Chat SDK `waitUntil`.
Atomic provider/partner/event dedupe uses the configured Chat SDK state adapter.

This seam does not make the adapter a queue or database. Hosts own request-size/rate limits,
durability, replay policy, application persistence, and long-running work.

## Native client escape hatch

`adapter.client` is the same read-only `LinqAPIV3` client used internally. Use it for provider-native
account, subscription, administrative, or proactive operations that do not warrant adapter APIs.

Linq `openDM()` remains unsupported because a recipient-derived provisional Chat SDK thread cannot
adopt Linq's returned canonical chat ID. For an auto-selected sender, call
`adapter.client.messages.create()` with one idempotency key per logical send, then construct
``chat.thread(`linq:${result.chat_id}`)`` after success. For an intentionally fixed line, use
`adapter.client.chats.create()` and the returned canonical `result.chat.id`. Provider creation,
reuse, sender selection, concurrency, and delivery semantics remain provider-owned.

## Identity and compatibility

The adapter emits only `linq:{chatId}`. It still decodes persisted historical
`linq:{chatId}:dm/group` values for released compatibility, but applications should not create new
IDs in those forms.

## Errors and responsibility boundary

Provider authentication, permission, validation, rate-limit, not-found, network, and provider
failures use the shared Chat SDK error taxonomy while retaining supported Linq code, trace ID,
retry-after, and cause data. A message-refresh `404` remains `null`; other missing resources use the
applicable shared not-found error.

The adapter does not own provider delivery/reliability, retries beyond the official SDK, account
configuration, capability probes, request-to-event correlation, ordering, queues, databases,
polling, application workflows, transcription, retention, edge HTTP policy, or deployment.

See [FEATURE_PARITY.md](FEATURE_PARITY.md) for the compact capability/evidence matrix.

## Development

```bash
pnpm --filter @forma/linq-chat-sdk-adapter test
pnpm --filter @forma/linq-chat-sdk-adapter typecheck
pnpm --filter @forma/linq-chat-sdk-adapter lint
pnpm --filter @forma/linq-chat-sdk-adapter format:check
pnpm --filter @forma/linq-chat-sdk-adapter build
pnpm --filter @forma/linq-chat-sdk-adapter openapi:check
```

The OpenAPI check intentionally covers only the canonical webhook event-name enum that backs the
public typed event contract. It does not certify Linq's provider-wide API inventory.
