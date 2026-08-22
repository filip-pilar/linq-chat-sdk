# @forma/linq-chat-sdk-adapter

A Linq adapter for [Chat SDK](https://www.npmjs.com/package/chat). It implements ordinary Chat SDK
behavior for existing Linq chats and exposes a deliberately small Linq-specific extension surface.
This is the private workspace package for the Forma-maintained fork; Linq's published package is
`@linqapp/chat-sdk-adapter`.

## Setup

```ts
import { Chat } from "chat";
import { createLinqAdapter } from "@forma/linq-chat-sdk-adapter";

const linq = createLinqAdapter({
  apiKey: process.env.LINQ_API_KEY!,
  signingSecret: process.env.LINQ_SIGNING_SECRET!, // Standard Webhooks secret
});

const chat = new Chat({ adapters: { linq } });
export const POST = chat.webhooks.linq;
```

Credentials can instead rotate through an asynchronous provider:

```ts
const linq = createLinqAdapter({
  credentials: async () => credentialStore.currentLinqCredentials(),
});
```

Every adapter-owned provider operation resolves a fresh client from lazy credentials. Static
`apiKey` configurations retain synchronous `adapter.client`; lazy configurations use
`await adapter.getClient()` for the native SDK escape hatch.

Configuration is validated when the adapter is constructed. The exported configuration interface
remains structurally compatible with released static, lazy, and trusted-forwarder combinations;
its optional fields alone do not prove that a usable credential and webhook authority were supplied.
Static direct verification validates the exact configured secret with `standardwebhooks` at
construction; malformed, empty, or whitespace-altered values fail without being trimmed. Lazy
secrets are validated when resolved for a request. An explicit trusted forwarder is the sole
authority and does not inspect an otherwise unused direct secret.

The host must pass the untouched request body to the route. The adapter verifies the
`webhook-id`, `webhook-signature`, and `webhook-timestamp` headers and enforces the Standard
Webhooks replay window before parsing or dispatching.

Managed forwarding can supply an explicit `webhookVerifier(request, rawBody)` instead. That verifier
is the sole authentication authority for the request: forwarded deliveries never fall back to the
direct signing secret, and direct deliveries never silently enter the forwarding path.

## Standard Chat SDK behavior

For canonical Linq thread IDs (`linq:{chatId}`), the adapter supports:

- posting and replying with text, Markdown/AST content, static cards, files, and attachments;
- editing text, fetching thread/history/message data, and backward pagination;
- whole-message reactions, typing, and chat-wide mark-read acknowledgements;
- inbound message and reaction dispatch through the ordinary Chat SDK handlers;
- native group-mention translation and `onNewMention()` routing without visible-`@` heuristics;
- canonical returned thread/message identities and lossless Linq raw message data.

Outbound media accepts public HTTPS references or caller-supplied bytes. Adapter-performed uploads
have a 30-second timeout and reject redirects, embedded credentials, localhost names, and literal
loopback, unspecified, private, link-local, carrier-grade NAT, benchmarking, multicast, and mapped
equivalents. This is a focused SSRF boundary, not a registry of every special-purpose address. DNS
resolution and the integrity of Linq-issued upload hosts remain provider/host-network concerns.
Preparation-only attachment cleanup is best effort; uncertain send recovery, retention, and
deletion policy are not adapter workflows. Inbound attachments retain a stable Linq attachment ID
and resolve a fresh downloadable URL when `fetchData()` runs.

History parsing isolates malformed/null/unknown parts and tombstones so usable siblings remain
available. Rows that cannot provide truthful canonical IDs, authorship, and RFC3339 timestamps are
omitted from the standard Chat SDK page. Usable rows are returned oldest-first by their complete
provider instant, including fractional precision beyond JavaScript milliseconds and normalized
offsets; exact ties preserve provider-relative order. `metadata.dateSent` remains a JavaScript
`Date`, while the immutable raw message retains the original full-precision timestamp.
Backward traversal skips at most ten consecutive all-filtered provider pages and stops on repeated
cursors. Forward history is not claimed.

### Proactive direct messages

The released `openDM(handle)` contract returns a deterministic `linq:pending:{handle}` bootstrap
thread because Linq cannot create an empty chat. Its first post uses `messages.create()` and returns
a `SentMessage` with the provider's canonical `linq:{chatId}` identity:

```ts
const pendingId = await linq.openDM("+15551234567");
const sent = await chat.thread(pendingId).post("Hello");
const canonical = chat.thread(sent.threadId);
```

Use the returned canonical thread for subscriptions and later operations. The pending `Thread`
identity is immutable and is not migrated in hidden state. Distinct posts are distinct logical
sends with distinct idempotency keys; the official SDK owns retries of one request, and Linq owns
chat creation/reuse, concurrent acceptance, sender selection, and delivery.

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
validated text decorations, one native group mention, and standalone native rich links. The
compiler produces deterministic plain text and UTF-16 ranges from raw text, supported Markdown/AST
styles, and applicable static-card text. Locally invalid or contradictory inputs fail before UUID
generation, attachment preparation, logging, or provider I/O.

Ordinary Chat SDK mention tokens work for existing group posts and replies:

```ts
await groupThread.post(`Please review this, ${groupThread.mentionUser(participantId)}`);
```

Mention-like syntax is parsed strictly: exactly one complete `<@target>` token is accepted, while
empty, nested, unbalanced, ambiguously wrapped, or multiple tokens fail before credentials, UUIDs,
media preparation, logging, or provider I/O. When the token contains a stable Linq participant ID,
the adapter resolves it once against that existing group and sends only when the response
establishes one current participant with a usable handle. A handle can be used directly without a
lookup. Provider-issued participant identity remains `Message.author.userId`; the handle remains
`Message.author.userName` and the native mention target. For explicit display text and range
control, use `mention` (UTF-16 `[start, end)` offsets):

```ts
await groupThread.post(
  linqMessage("Hey Kevin, can you confirm?", {
    mention: { handle: "+14155551234", range: [4, 9] },
  }),
);
```

Mentions require one text part in an existing group and cannot share that part with manual
decorations or a rich link. Derived bold/italic/strikethrough may degrade to plain text so the
native mention remains truthful. Explicit RCS/SMS requests are accepted: Linq documents native
iMessage highlighting and plain-text RCS/SMS behavior, without an adapter presentation guarantee.

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

const poll = await conversation.polls.create({ options: ["Tacos", "Sushi"] });
await conversation.polls.addOptions(poll.messageId, ["Pizza"]);
await conversation.polls.vote(poll.messageId, {
  optionId: poll.options[0]!.optionId,
  operation: "add",
});
const currentPoll = await conversation.polls.retrieve(poll.messageId);
```

Ordinary replies, reactions, start-typing, and mark-read remain standard Chat SDK operations.
Group/location/voice-memo results expose only facts established by the provider response; they do
not imply delivery, consent, correlation, playback, presentation, or workflow completion.

Polls are existing-chat, iMessage-native operations. Create requires at least two options; options
are add-only; one vote call toggles one option. The immutable snapshot exposes validated current
provider facts plus the lossless raw response. Create preserves a supplied idempotency key or
generates one key per logical request;
add-option and vote calls disable SDK retries because their current request contracts have no
idempotency key. Poll events remain observations, not a polling service or workflow state machine.

Inbound user voice memos arrive through the standard media path as downloadable audio attachments.
The current canonical schema does not reliably distinguish a native Messages voice memo from an
ordinary audio attachment, so the adapter does not invent a discriminator. Transcription belongs
to the consuming application.

Inbound `.vcf` contact cards use the same standard media contract: a `text/vcard` file attachment
with stable Linq attachment identity and secure `fetchData()`. Parsing the vCard, resolving contact
identity, and changing an address book belong to the consuming application. The separate
`shareContactCard()` operation remains Linq's configured iMessage Name and Photo Sharing action;
account-level contact-card configuration remains on the native client.

## Verified Linq events

The ordinary `Chat.webhooks.linq` route is the primary integration. For consumers that need Linq
facts beyond standard message/reaction handlers, the adapter also exposes:

- `onLinqEvent(name | names, handler)` for typed current events, or `onLinqEvent(handler)` for all
  lossless verified events;
- `verifyWebhook(request)` for a branded verified observation without dispatch;
- `dispatchVerifiedWebhook(verified, options)` for dispatching only a result produced by the same
  adapter instance.

```ts
const unsubscribe = linq.onLinqEvent(["message.delivered", "message.failed"], async (event) => {
  console.log(event.type, event.data.providerMessageId, event.rawEvent);
});
```

The released `onDeliveryStatus(listener)` API remains as a smaller compatibility view of the same
authenticated `message.sent`, `message.delivered`, `message.read`, and `message.failed` facts. It
shares verification and dedupe with `onLinqEvent()` and does not imply ordering, terminal state, or
request correlation. Each event snapshots its listener membership before invocation. Listener
completion is not awaited; synchronous throws and rejected thenables are logged and isolated from
sibling callbacks and acknowledgement.

Verification preserves immutable envelope, transport, normalized observations, `rawEvent`, exact
raw text, and raw bytes. Current known payloads receive typed discriminants when their facts support
a truthful projection. Canonical event names without a curated adapter model (for example group,
participant, status, or typing events) reach their exact named handler with raw provider data as
well as the all-event handler; this does not create a curated model. An authenticated curated event
whose payload cannot support its promised projection is generic/lossless only. Unknown/future
names are also generic-only, and none are forced through an incompatible standard handler. Generic
callbacks are failure-isolated and participate in Chat SDK `waitUntil`.
Schema-valid timestamp strings that JavaScript `Date` cannot represent remain available to the
truthful Linq named/generic observation; only the incompatible standard `Message` projection is
skipped.
Atomic provider/partner/event dedupe uses the configured Chat SDK state adapter.

All nine current poll event families (`poll.received`, lifecycle, update, failure, vote, and
reaction events) use this same typed/lossless verified pipeline. Valid poll events reach their exact
named and generic handlers; malformed curated poll payloads remain generic-only. There is no
parallel `onPoll()` API and no automatic retrieval after an event.

This seam does not make the adapter a queue or database. Hosts own request-size/rate limits,
durability, replay policy, application persistence, and long-running work.

## Native client escape hatch

Static credential configurations expose `adapter.client`, the same official `LinqAPIV3` client used
internally. The property is read-only, but the client retains the official SDK's provider
operations. All configurations expose `await adapter.getClient()`; lazy configurations create that
client from the current credential result and intentionally reject synchronous `.client` access
rather than cache a stale key. Use the native client deliberately for account, subscription,
administrative, or other provider-native operations that do not warrant adapter APIs.

Chat backgrounds remain on this escape hatch. Current Linq guidance mentions `glitter`, while the
installed SDK and canonical request schema expose `sky`, `water`, and `aurora` (response/event
contracts may still contain `glitter`). The adapter does not freeze a wrapper until that request
contract aligns and a reusable consumer need justifies one. Canonical background events are still
available through exact named/raw `onLinqEvent()` handlers.

## Identity and compatibility

The adapter emits only `linq:{chatId}`. It still decodes persisted historical
`linq:{chatId}:dm/group` values for released compatibility, but applications should not create new
IDs in those forms.

Released callers may still invoke `adapter.markRead(threadId, messageId)` as a compatibility alias.
It delegates to the same chat-wide acknowledgement as the preferred Chat SDK
`Thread.markAsRead()` path.

## Errors and responsibility boundary

Provider authentication, permission, validation, rate-limit, not-found, network, and provider
failures use the shared Chat SDK error taxonomy while retaining supported Linq code, trace ID,
retry-after, and cause data. A message-refresh `404` remains `null`; other missing resources use the
applicable shared not-found error. SDK JSON responses are checked for the minimum IDs, booleans,
timestamps, and nested facts needed to construct public Chat SDK/facade results. A malformed success
response fails as a provider-protocol error rather than fabricating an identity. Once a mutation may
have been accepted, the adapter neither retries nor performs preparation cleanup; recovery from
uncertain acceptance remains application/provider-owned.

The adapter does not own provider delivery/reliability, retries beyond the official SDK, account
configuration, capability probes, request-to-event correlation, ordering, queues, databases,
polling, application workflows, transcription, retention, edge HTTP policy, or deployment.
AI-agent tools, prompts, authorization, and autonomous poll/mention policy are consuming-application
responsibilities; the adapter exposes primitives only.

See [FEATURE_PARITY.md](FEATURE_PARITY.md) for the compact capability/evidence matrix.

## Development

The peer floor remains Chat SDK `4.38`: the combined public contract uses the adapter-level
`reply()` and `markAsRead()` hooks that are absent from the released `4.28.1` declarations/runtime.

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
