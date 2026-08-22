# Linq adapter scope

The adapter is a reusable, application-neutral translation between Chat SDK and Linq. Its current
capability status is maintained in
[`packages/adapter-linq/FEATURE_PARITY.md`](packages/adapter-linq/FEATURE_PARITY.md).

## Adapter-owned

- Standard Chat SDK operations for existing chats: post, reply, edit, history, refresh, reactions,
  typing, mark-read, cards, files, attachments, and buffered streams.
- Released proactive `openDM()` bootstrap semantics: pending handle identity before the first post,
  then canonical provider identity from the accepted send.
- Static and lazy rotating credentials, explicit trusted webhook forwarding, and the released
  delivery-status compatibility callback over the richer verified event pipeline.
- Released `adapter.markRead()` source compatibility as an alias of the preferred standard
  `Thread.markAsRead()` chat-wide acknowledgement.
- Canonical `linq:{chatId}` identity and decode-only compatibility for persisted
  `linq:{chatId}:dm/group` values.
- Deterministic text/decoration compilation, service/effect policy, native rich links, outbound
  native group mentions, media preparation/downloads, shared error translation, and defensive
  parsing. Authenticated owner-targeted mentions enter standard Chat SDK `onNewMention()` routing.
- Standard Webhook verification over the exact raw body, stable typed/lossless observations,
  current message/reaction dispatch, atomic event dedupe, callback isolation, and Chat SDK
  `waitUntil` integration.
- Exact static signing-secret validation, full-precision provider timestamp ordering, and narrow
  SDK-response guards for facts used in public identities/results.
- A narrow `adapter.conversation(threadOrId)` extension for part-targeted replies/reactions,
  stop-typing, contact-card sharing, voice memos, existing-group operations, location, and polls.
- A truthful official-client escape hatch: synchronous `adapter.client` for static credentials and
  `await adapter.getClient()` for static or lazy credentials.

## Deliberate limits

- A pending `openDM()` thread is only a bootstrap address. Its identity is not migrated; consumers
  use the returned `SentMessage.threadId` for subscriptions and later ordinary operations.
- The adapter does not own provider delivery, ordering, retries beyond the SDK, account
  administration, capability discovery, workflow state, databases, durable queues, polling,
  retention/deletion policy, transcription, or request-to-event correlation.
- HTTP request-size limits, rate limiting, availability policy, and deployment lifecycle belong to
  the host/proxy.
- A malformed `message.received` event without a canonical or previously learned chat kind remains
  available through verified raw observation but is not guessed, looked up, or sent to the wrong
  standard handler.
- Valid canonical events without curated adapter models reach named handlers with raw data. Known
  curated events with unusable payloads remain available only through the generic lossless seam and
  receive `2xx`; they do not produce false named, curated, delivery, or standard dispatch.
- A schema-valid timestamp string that JavaScript `Date` cannot represent remains observable in a
  truthful Linq event; only the incompatible standard `Message` projection is skipped.
- Inbound voice memos are ordinary downloadable audio attachments. Linq's current schema does not
  reliably distinguish them from other audio media.
- Inbound vCards are ordinary downloadable `text/vcard` file attachments. Parsing or applying a
  contact is application-owned.
- Poll snapshots and events are provider facts, not delivery, request/event correlation, polling,
  or application workflow guarantees.
- Current history traversal is backward-only and bounded. It skips a bounded number of all-filtered
  provider pages so usable later messages are not hidden. Rows without truthful canonical identity,
  authorship, and RFC3339 timestamps are omitted; usable messages are stably oldest-first by the
  complete normalized provider instant while immutable raw values retain their original precision.
- Public result identities are built only from required validated provider facts. A malformed
  response after possible mutation acceptance is not retried or treated as safe to clean up.
- Adapter-performed attachment uploads reject redirects and obvious local-network literal targets
  and time out after 30 seconds. The filter is intentionally not a registry of every special-use
  address; DNS and Linq-issued upload-host integrity remain provider/host network concerns.

## Deferred possibilities

- iMessage app-message support remains deferred.
- Accepting raw Chat SDK `FileUpload` as a third voice-memo source is optional. Large-file
  streaming requires demonstrated need; upload workflows and retention remain out of scope.
- Curated group/presence event models remain deferred; lossless generic events remain
  available.
- Chat backgrounds remain provider-native while current guidance and installed request enums
  disagree (`glitter` versus `sky`/`water`/`aurora`). Named/raw events remain observable.
- AI-agent tools, prompts, authorization, and autonomous poll/mention policy remain application-owned.

These are not active roadmap commitments. Provider/device/live observations are optional evidence,
not adapter completion or release gates.
