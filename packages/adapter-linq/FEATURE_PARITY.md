# Linq feature parity

This document is the authoritative capability inventory and implementation backlog for the Linq
Chat SDK adapter. **Feature parity means complete, non-lossy coverage of Linq's chat and messaging
capabilities**, not a second wrapper around the entire Linq SDK.

The inventory is the authoritative status matrix for adapter-owned capabilities and records the
native-client and out-of-scope boundary. Consolidated Batch `000` refreshed the full mechanical
inventory; Batch `005` must use the current event enum and preserve unknown future events losslessly.

Sources of truth:

- [Linq documentation index](https://docs.linqapp.com/llms.txt)
- [Linq Partner API V3 OpenAPI document](https://cdn.linqapp.com/openapi/linq-api-v3.yaml)
- [`chat` adapter contract](https://chat-sdk.dev/docs/contributing/building)

Evidence reverified **2026-08-19**: the canonical OpenAPI has **68 callable operations**, **56
webhook example operation IDs**, **124 operation IDs total**, and **45 webhook event names**. The
checked-in `openapi-inventory.json` and `pnpm openapi:check` detect drift. The installed client is
**`@linqapp/sdk@0.42.0`**. It exposes current native resources but removed `webhooks.unwrap()` and
generated wrapper event unions while provider documentation still describes that helper. The
adapter owns inbound authentication/envelopes; it does not hand-write native endpoint wrappers.

## Status, priority, and disposition

| Status       | Meaning                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| Complete     | Meets the definition of done below.                                                                         |
| Partial      | Some behavior exists, but its API, constraints, errors, docs, or tests are incomplete.                      |
| Missing      | Required adapter behavior or native-client boundary is not complete yet.                                    |
| Client API   | Intentionally available only through read-only `adapter.client`; no bespoke adapter method is required.     |
| Out of scope | Kept only to make the boundary audit complete; no supported adapter behavior or roadmap is planned.         |
| Deprecated   | Kept in the inventory for completeness, but no new adapter API is planned unless Linq reverses deprecation. |

| Priority | Meaning                                                                                 |
| -------- | --------------------------------------------------------------------------------------- |
| P0       | Foundational correctness, reliability, or broadly used messaging behavior.              |
| P1       | Broadly useful conversation, identity, group, health, or lifecycle behavior.            |
| P2       | Valuable specialized chat or messaging behavior.                                        |
| —        | No adapter implementation priority: native client, recipe, deprecated, or out of scope. |

No `Partial` capability should be described as supported without its limitation. A capability only
moves to `Complete` when every applicable definition-of-done item is satisfied.

Every inventory row also has exactly one architectural disposition:

| Disposition               | Decision rule                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Standard Chat SDK mapping | A standard Chat SDK API faithfully represents the behavior; provider-specific translation stays behind that API.                           |
| Internal adapter behavior | Required to implement standard messaging correctly, but not exposed as a separate public API.                                              |
| Typed Linq chat extension | Native conversation or message behavior that Chat SDK cannot faithfully express; expose the smallest typed extension.                      |
| Native Linq client        | Endpoint-shaped account, administration, business, or low-level operation; use read-only `adapter.client` without a bespoke wrapper.       |
| Recipe                    | A useful workflow composed from `adapter.client` and stable chat primitives; document it without adding a payment- or domain-specific API. |
| Out of scope              | Inventory-only capability with no planned adapter behavior, recipe, tests, or implementation batch.                                        |

Apply this litmus test to every proposed public method, class, error, option, and exported type: if
it only renames or reshapes an existing Chat SDK, shared-adapter, or official Linq client surface
with essentially the same semantics, do not add it. Use the existing standard surface or
`adapter.client` instead.

## Target public API shape

Preserve `createLinqAdapter(config)` and all existing Chat SDK behavior. Keep the public surface in
three deliberately small layers:

1. Use standard Chat SDK APIs when their semantics match Linq:
   `thread.post()`, `thread.reply()`, `thread.markAsRead()`, `thread.messages`,
   `thread.startTyping()`, message edit/reactions, and standard
   message/reaction handlers. `chat.openDM()` is intentionally unsupported for Linq. Proactive sends
   use the native-client recipe in Batch `004`, then resume standard behavior on the returned
   canonical `linq:{chatId}` thread.
2. Add typed Linq extensions only for chat-native behavior with no faithful Chat SDK equivalent:
   contact-card sharing, native voice memos, effects/decorations, protocol selection, location,
   group management, iMessage app messages, typed Linq chat events, and generic verified Linq event
   passthrough. Prefer a small set of cohesive message/thread options over one adapter method per
   endpoint.
3. Expose the official Linq client as a read-only `adapter.client: LinqAPIV3` property, following
   Chat SDK's native-client convention. Account and business operations—including contact-card
   configuration, phone-number administration, webhook-
   subscription CRUD, Payment Request management, experience discovery, and attachment
   administration—are used through that client. Do not duplicate them with bespoke adapter
   wrappers.
4. Export the `LinqAdapter` type and Linq-specific input, result, event, and error types needed by
   those methods. Do not require Forma infrastructure, state, naming, or environment variables.

API names below are the intended public shape for direct chat scope. `adapter.client.*` names are the
official client's surface and may move with its generated types; the adapter must not re-export a
parallel facade. A PR may refine a proposed chat-extension name, but it must update this document
and explain the compatibility impact.

Scope terms used throughout this roadmap:

- **Payments** means a documented recipe for accepting customer payments with Linq Payment
  Requests. Create and manage the request through `adapter.client.paymentRequests`, send its
  `checkout_url` using the adapter's general rich-link chat capability, and observe lifecycle events
  through generic typed `onLinqEvent` passthrough. There is no payment facade or payment-specific
  adapter workflow.
- **Contact card** means sharing the sending number's already-configured Name and Photo card into an
  iMessage conversation so the recipient can save it. Configure the card through `adapter.client`, the
  Linq dashboard, or another official Linq surface; sharing it is a typed chat extension.
- **Agentcard** is intentionally unsupported. The adapter will not provide, document, or prioritize
  workflows in which an agent pays on a customer's behalf. If a future official client makes those
  resources transitively reachable through `adapter.client`, they still receive no adapter contract,
  convenience API, examples, or dedicated tests.

## Implementation guardrails

These rules are normative for every implementation plan and change in this package.

### Public API discipline

- Standard Chat SDK APIs and shared adapter primitives are the primary surface. Endpoint-shaped
  operations remain on `adapter.client`.
- A Linq-specific export is allowed only for a documented semantic gap that the standard and native
  surfaces cannot express faithfully. Its proposal must identify those alternatives and explain why
  each is insufficient.
- Keep any justified extension minimal and cohesive; do not export provider-shaped aliases, helper
  types, options, errors, or classes solely for parity or convenience.

### Error policy

- Prefer `ValidationError`, `AdapterRateLimitError`, `AuthenticationError`, `PermissionError`,
  `ResourceNotFoundError`, `NetworkError`, and `AdapterError` from `@chat-adapter/shared`.
- Do not create Linq-specific validation, rate-limit, authentication, permission, not-found,
  network, or generic provider errors merely to rename standard behavior.
- A Linq-specific error or error type is allowed only when essential Linq metadata cannot be
  preserved through the standard contract. Document the missing semantic, retained metadata, and
  consumer need, then contract-test the exception.

### Retry, idempotency, and side-effect safety

- Do not duplicate retry behavior already owned by the official Linq client. Before adding any
  adapter retry, classify the operation's side effects, idempotency, and replay consequences.
- Retry only when the operation is safely idempotent or uses a verified idempotency mechanism.
  Reuse one idempotency value across retries of one logical operation; generate a new value for a
  distinct operation.
- Never infer one endpoint's idempotency or retry safety from another endpoint.
- Cleanup may target only resources definitely created and orphaned by the adapter. It is
  best-effort, must not broaden the deletion target, and must never replace the primary error.

### Evidence and ambiguity

- Treat current official Linq documentation and the installed official SDK's behavior and types as
  primary evidence. Record documentation/SDK discrepancies, including the installed version, in
  the relevant implementation notes or parity row.
- Do not invent behavior when semantics are ambiguous. Keep the affected capability `Partial`,
  `Missing`, or explicitly blocked until verified.
- Distinguish provider-enforced constraints from constraints the adapter can reliably validate
  locally; do not claim local enforcement without the required evidence and inputs.

### Planning and definition of done

- Every proposed public export must record the standard and native alternatives considered.
- Every implementation plan must trace each verified constraint or risk to an implementation rule,
  test, documentation update, or explicit deferral.
- Update every affected parity row in the same change that alters behavior. Do not mark a broad row
  `Complete` when only one path, input form, protocol, or other subset is covered.

## Definition of done by disposition

### Standard Chat SDK mapping

- The standard Chat SDK API is the only primary public API; no Linq convenience alias is added.
- Provider translation, constraints, stable errors, normalization, retries, and hostile input are
  covered by unit and Chat SDK adapter contract tests.
- Public documentation uses the standard API, and applicable behavior has a live sandbox/device
  test with explicit assertions.
- Existing factory and standard adapter behavior remain compatible or include a migration plan.

### Internal adapter behavior

- No separate public method or exported endpoint-shaped input/result type is added.
- The behavior is exercised through the standard Chat SDK operation it supports, including
  validation, provider errors, retries, resource cleanup, and malformed input.
- Unit/contract coverage proves the internal path; focused documentation and live tests are required
  only when users must understand a visible limitation or device behavior.

### Typed Linq chat extension

- Chat SDK cannot faithfully express the native conversation/message semantics, and the matrix
  records why.
- The smallest cohesive typed method, option, or event API preserves Linq constraints and results
  without mirroring an endpoint one-for-one.
- Stable errors, documentation with an example, unit/contract coverage, and an applicable live
  sandbox/device test are complete.

### Native Linq client

- `adapter.client: LinqAPIV3` is public, read-only, and retains the official client's native types.
- A single public-surface contract proves identity and compile-time read-only assignment.
- The package links to official Linq client/API documentation and adds no operation-specific wrapper,
  validation, error translation, endpoint test, or live test. Those remain owned by Linq.
- Rows absent from the resolved official client remain `Missing`; do not hand-write HTTP wrappers.

### Recipe

- A focused documentation example composes `adapter.client` and existing chat/event primitives; it
  introduces no recipe-specific adapter API or exported type.
- The example states prerequisites, data ownership, security/error boundaries, and which primitive
  tests provide coverage. Add a recipe-level live test only when it proves integration behavior not
  already owned by Linq or a primitive.

### Out of scope

- The capability remains visible in the complete inventory with the reason it is excluded.
- It receives no public API, convenience wrapper, example, dedicated test, live test, or
  implementation batch. Generic verified event passthrough may carry its envelope without creating
  domain behavior.

## Concise roadmap

| Area                         | Primary disposition(s)                       | Current state | Next completion target                                                  |
| ---------------------------- | -------------------------------------------- | ------------- | ----------------------------------------------------------------------- |
| Existing-chat text/media     | Standard mapping + internal behavior         | Partial       | Rich options plus Batch `012` media lifecycle and live edge coverage    |
| Proactive send/chat creation | Native client + recipe                       | Client API    | Batch `004` recipe/contracts plus sandbox validation; no `openDM()`     |
| Webhooks                     | Standard + internal + typed chat extension   | Partial       | Generic typed passthrough, dedupe, then chat lifecycle fidelity         |
| Contact sharing/read/voice   | Standard mapping + typed Linq extension      | Partial       | Standard chat-wide read; share card/presence/voice device tests         |
| Groups and location          | Typed Linq chat extension                    | Partial       | Cohesive chat APIs, lifecycle events, and sandbox tests                 |
| Rich messaging               | Standard mapping + typed Linq chat extension | Partial       | Batches `007`/`010`; iMessage app messages remain deferred              |
| Native client boundary       | Native Linq client                           | Complete      | Batch `002`: exported `LinqAdapter` + read-only, identity-tested client |

Recipes are tracked separately from implementation work; see [Recipes](#recipes).

### Batch `004` proactive native-client recipe

Proactive sending remains unsupported as adapter behavior, and `chat.openDM()` is intentionally
unsupported for Linq. Linq already provides an atomic create-or-reuse-and-send operation, while Chat
SDK's `openDM()`/`thread.post()` split cannot expose that operation without provisional identity
machinery. The approved design avoids that mismatch instead of changing Chat SDK.

Chat SDK Thread identity is immutable: returning a canonical ID from the first send cannot mutate a
provisional recipient Thread. Reusing that object can repeat the create/send path, while
subscriptions and state remain attached to the provisional ID. This is the concrete negative
contract behind the no-provisional-identity boundary.

Use `adapter.client.messages.create()` for an auto-selected sending line, with one idempotency key
per logical send. After Linq returns `chat_id`, construct ``chat.thread(`linq:${chatId}`)`` and use
normal Chat SDK subscriptions, history, typing, reactions, edits, and subsequent posts. Use
`adapter.client.chats.create()` when the application must choose the sending line explicitly.

Batch `004` is reduced to recipe documentation, compile-time contracts, and sandbox validation. It
adds no runtime adapter method, provisional thread ID, alias, identity migration, persistence
scheme, first-send lock, retry loop, or Chat SDK dependency change. Sandbox completion requires
new-chat creation, active-chat reuse, same-key idempotent retry, failover, and concurrent distinct
intentional sends. A first-class proactive extension remains deferred until demonstrated usage
justifies it.

## Endpoint parity

The `Disposition` column is normative. The `Adapter API` column names the supported public surface,
not every internal SDK call. `Missing` on a native-client row means `adapter.client` is still private
or the resolved official client lacks that operation.

### Attachments

| Linq operation                                                     | Disposition               | Adapter API                           | Status     | Limitations / completion gap                                                                                                                                                                | Priority | Test coverage                                                                                                  |
| ------------------------------------------------------------------ | ------------------------- | ------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `POST /v3/attachments` — pre-upload a file                         | Internal adapter behavior | `thread.post({ files })`              | Partial    | Name/size validation, no-retry creation, preparation cleanup, and shared errors work; readiness, upload retries, complete formats, send-time lifecycle, and retention wait for Batch `012`. | P0       | Unit: upload/cleanup/error cases in `adapter.test.ts` and `outbound-send.test.ts`; live: `smoke-live.mjs send` |
| `GET /v3/attachments/{attachmentId}` — retrieve metadata/fresh URL | Internal adapter behavior | Attachment `fetchData()`/rehydration  | Partial    | Refresh is internal to standard attachment downloads; expiry and ephemeral-tier live coverage remain incomplete.                                                                            | P0       | Unit: `inbound-media.test.ts`, rehydration cases in `adapter.test.ts`; live: none                              |
| `DELETE /v3/attachments/{attachmentId}` — delete attachment        | Native Linq client        | `adapter.client.attachments.delete()` | Client API | Attachment administration is not standard message/file behavior; official client semantics apply.                                                                                           | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq                                             |

### Available number and capabilities

| Linq operation                                      | Disposition        | Adapter API                                 | Status     | Limitations / completion gap                                                                | Priority | Test coverage                                                      |
| --------------------------------------------------- | ------------------ | ------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `GET /v3/available_number` — choose onboarding line | Native Linq client | `adapter.client.availableNumber.retrieve()` | Client API | Account onboarding, not a chat abstraction.                                                 | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `POST /v3/capability/check_imessage`                | Native Linq client | `adapter.client.capability.checkIMessage()` | Client API | Endpoint-shaped capability query; internal routing may consume it without adding a wrapper. | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `POST /v3/capability/check_rcs`                     | Native Linq client | `adapter.client.capability.checkRCS()`      | Client API | Endpoint-shaped capability query; internal routing may consume it without adding a wrapper. | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |

### Blocked handles

| Linq operation               | Disposition        | Adapter API                               | Status     | Limitations / completion gap                                      | Priority | Test coverage                   |
| ---------------------------- | ------------------ | ----------------------------------------- | ---------- | ----------------------------------------------------------------- | -------- | ------------------------------- |
| `GET /v3/blocked_handles`    | Native Linq client | `adapter.client.blockedHandles.list()`    | Client API | Account safety administration; official SDK semantics apply.      | —        | Endpoint behavior owned by Linq |
| `POST /v3/blocked_handles`   | Native Linq client | `adapter.client.blockedHandles.block()`   | Client API | Blocking is endpoint-shaped and must not become an adapter alias. | —        | Endpoint behavior owned by Linq |
| `DELETE /v3/blocked_handles` | Native Linq client | `adapter.client.blockedHandles.unblock()` | Client API | Official SDK validation and errors apply.                         | —        | Endpoint behavior owned by Linq |

### Chats

| Linq operation                                                | Disposition               | Adapter API                                                  | Status     | Limitations / completion gap                                                                                                                                                                                               | Priority | Test coverage                                                       |
| ------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| `POST /v3/chats` — create chat with initial message           | Native Linq client        | `adapter.client.chats.create()`                              | Client API | Explicit fixed-line creation remains native-client behavior. Guarded smoke operations use this contract and verify the returned owner; do not add `adapter.createChat()` or route it through `openDM()`.                   | —        | Public-client contract; typed smoke contract + device send          |
| `GET /v3/chats` — list chats                                  | Native Linq client        | `adapter.client.chats.listChats()`                           | Client API | Chat SDK has no faithful chat-list contract; do not add `adapter.listChats()`.                                                                                                                                             | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq  |
| `GET /v3/chats/{chatId}` — retrieve chat                      | Internal adapter behavior | Standard thread construction/refresh                         | Partial    | Internal mapping works and preserves raw metadata; not-found and live coverage remain incomplete.                                                                                                                          | P0       | Unit: thread/identity cases in `adapter.test.ts`; live: indirect    |
| `PUT /v3/chats/{chatId}` — update group name/icon             | Typed Linq chat extension | `adapter.conversation(threadOrId).group.update()`            | Missing    | Group-only behavior; public HTTPS icon validation and typed success/failure events required. Do not promise exact request correlation without a provider key.                                                              | P1       | None                                                                |
| `POST /v3/chats/{chatId}/leave` — leave group                 | Typed Linq chat extension | `adapter.conversation(threadOrId).group.leave()`             | Missing    | Group/member minimums, post-leave behavior, participant event observation, and disposable-group live coverage required.                                                                                                    | P2       | None                                                                |
| `GET /v3/chats/{chatId}/location` — get shared locations      | Typed Linq chat extension | `adapter.conversation(threadOrId).location.retrieve()`       | Missing    | GeoJSON longitude-first order, freshness, handle matching, empty results, and polling guidance required.                                                                                                                   | P1       | None                                                                |
| `POST /v3/chats/{chatId}/location/request`                    | Typed Linq chat extension | `adapter.conversation(threadOrId).location.request()`        | Missing    | One-to-one iMessage constraints, recipient consent, and asynchronous sharing lifecycle required.                                                                                                                           | P1       | None                                                                |
| `POST /v3/chats/{chatId}/messages` — send to existing chat    | Standard Chat SDK mapping | `thread.post()` / `thread.reply()`                           | Partial    | Text/media/cards and ordinary replies have central limits, one idempotency key across SDK retries, shared errors, and Chat contracts; rich links, part-index reply, effects, protocol, formatting, and Batch `012` remain. | P0       | Unit: text/media/reply/retry contracts; live: `send`, `cards`       |
| `GET /v3/chats/{chatId}/messages` — list chat messages        | Standard Chat SDK mapping | `thread.messages` / `thread.allMessages`                     | Partial    | Cursor/limit and retrieved `parts: null` fallback work. Tombstone-page integrity, malformed/null parts, direction, rich normalization, and live pagination remain incomplete.                                              | P0       | Unit: null fallback only; tombstone/malformed/live coverage missing |
| `POST /v3/chats/{chatId}/participants` — add participant      | Typed Linq chat extension | `adapter.conversation(threadOrId).group.addParticipant()`    | Missing    | iMessage group-only constraints, limits, handle validation, and typed event observation required.                                                                                                                          | P1       | None                                                                |
| `DELETE /v3/chats/{chatId}/participants` — remove participant | Typed Linq chat extension | `adapter.conversation(threadOrId).group.removeParticipant()` | Missing    | iMessage group-only constraints, minimum size, self-removal distinction, and typed event observation required.                                                                                                             | P1       | None                                                                |
| `POST /v3/chats/{chatId}/read` — mark read                    | Standard Chat SDK mapping | `thread.markAsRead(messageOrId)`                             | Partial    | Implemented through the standard Chat API; Linq marks the entire chat and ignores message granularity. Sandbox/device and repeated-error evidence remain.                                                                  | P1       | Unit + Chat SDK contract in `outbound-send.test.ts`                 |
| `POST /v3/chats/{chatId}/share_contact_card`                  | Typed Linq chat extension | `adapter.conversation(threadOrId).shareContactCard()`        | Missing    | Shares the configured Name and Photo card in iMessage after prior outbound activity; configuration remains on `adapter.client`/dashboard.                                                                                  | P1       | None                                                                |
| `POST /v3/chats/{chatId}/typing` — start typing               | Standard Chat SDK mapping | `thread.startTyping()`                                       | Partial    | DM start works; long-work refresh, stable error semantics, and live duration remain incomplete.                                                                                                                            | P1       | Unit: typing cases in `adapter.test.ts`; live: indirect             |
| `DELETE /v3/chats/{chatId}/typing` — stop typing              | Typed Linq chat extension | `adapter.conversation(threadOrId).stopTyping()`              | Missing    | Chat SDK has no stop method; document automatic clear-on-send/timeout and avoid a raw endpoint alias.                                                                                                                      | P2       | None                                                                |
| `POST /v3/chats/{chatId}/voicememo`                           | Typed Linq chat extension | `adapter.conversation(threadOrId).sendVoiceMemo()`           | Missing    | Initially accept public HTTPS URL or existing attachment ID only. Raw bytes/upload lifecycle wait for Batch `012`; native iMessage and RCS/SMS fallback need live tests.                                                   | P1       | Unit: ordinary audio only; live: none                               |
| `POST /v3/chats/{chatId}/background`                          | Native Linq client        | `adapter.client.chats.background.set()`                      | Client API | Endpoint-shaped asynchronous background administration; success/failure may be observed generically.                                                                                                                       | —        | Endpoint behavior owned by Linq                                     |
| `DELETE /v3/chats/{chatId}/background`                        | Native Linq client        | `adapter.client.chats.background.remove()`                   | Client API | Reset behavior remains native-client-only.                                                                                                                                                                                 | —        | Endpoint behavior owned by Linq                                     |
| `POST /v3/chats/{chatId}/polls`                               | Native Linq client        | `adapter.client.chats.polls.create()`                        | Client API | Poll workflow is out of adapter scope; official client owns iMessage constraints.                                                                                                                                          | —        | Endpoint behavior owned by Linq                                     |

### Contact cards

**Disposition:** Native Linq client. These operations set the Name and Photo card for a sending
number and remain available through `adapter.client` or the Linq dashboard. Sharing that configured
card into an iMessage chat is a direct typed chat extension tracked above; it is native Name and
Photo Sharing, not a `.vcf` attachment.

| Linq operation                          | Disposition        | Adapter API                             | Status     | Limitations / completion gap                          | Priority | Test coverage                                                      |
| --------------------------------------- | ------------------ | --------------------------------------- | ---------- | ----------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `GET /v3/contact_card` — retrieve cards | Native Linq client | `adapter.client.contactCard.retrieve()` | Client API | Configuration query, not chat behavior.               | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `POST /v3/contact_card` — set up card   | Native Linq client | `adapter.client.contactCard.create()`   | Client API | Account/device configuration is not adapter behavior. | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `PATCH /v3/contact_card` — update card  | Native Linq client | `adapter.client.contactCard.update()`   | Client API | Account/device configuration is not adapter behavior. | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |

### Experiences and messages

**Disposition:** Native Linq client. Experience discovery is boundary-audit functionality with no direct
adapter priority or implementation batch. Message creation, retrieval, editing, reactions, reply
threads, and iMessage app-card updates remain direct chat scope.

| Linq operation                                           | Disposition               | Adapter API                                    | Status     | Limitations / completion gap                                                                                                                                                                                         | Priority | Test coverage                                                                       |
| -------------------------------------------------------- | ------------------------- | ---------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `GET /v3/experiences` — list invokable experiences       | Native Linq client        | `adapter.client.experiences.list()`            | Client API | Available in `@linqapp/sdk@0.42.0`; no bespoke adapter discovery API.                                                                                                                                                | —        | Endpoint behavior owned by Linq                                                     |
| `GET /v3/experiences/{experience}`                       | Native Linq client        | `adapter.client.experiences.retrieve()`        | Client API | Available in `@linqapp/sdk@0.42.0`; invocation remains native client behavior.                                                                                                                                       | —        | Endpoint behavior owned by Linq                                                     |
| `POST /v3/messages` — auto-selected sender               | Native Linq client        | `adapter.client.messages.create()`             | Client API | Approved proactive recipe: one idempotency key per logical send, then construct a canonical Chat SDK thread from returned `chat_id`. Creation/reuse/retry/failover/concurrency require Batch `004` sandbox evidence. | —        | Public-client contract; Batch `004` live validation                                 |
| `GET /v3/messages/{messageId}`                           | Internal adapter behavior | Standard message/history/refresh behavior      | Partial    | Parsing works; delivery/reaction/rich-part normalization, error/trace contracts, and live coverage are incomplete.                                                                                                   | P0       | Unit: retrieved-message parser cases in `adapter.test.ts`                           |
| `PATCH /v3/messages/{messageId}` — edit text part        | Standard Chat SDK mapping | `SentMessage.edit()`                           | Partial    | Part 0 works; outbound-only, time/edit-count, text-part, and part-index constraints need stable handling.                                                                                                            | P1       | Unit: part-0 happy path only; live: none                                            |
| `DELETE /v3/messages/{messageId}` — delete Linq record   | Native Linq client        | `adapter.client.messages.delete()`             | Client API | Storage deletion is not recipient unsend and must never back Chat SDK `SentMessage.delete()`.                                                                                                                        | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq                  |
| `POST /v3/messages/{messageId}/reactions`                | Standard Chat SDK mapping | `SentMessage.addReaction()`/`removeReaction()` | Partial    | Standard/custom emoji work; part-specific/sticker behavior and async error/live coverage remain incomplete.                                                                                                          | P0       | Unit: `reactions.test.ts`, adapter webhook cases; live: inbound reaction in `serve` |
| `GET /v3/messages/{messageId}/thread`                    | Native Linq client        | `adapter.client.messages.listMessagesThread()` | Client API | Linq reply threads do not match Chat SDK conversation threads; avoid an endpoint-shaped wrapper.                                                                                                                     | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq                  |
| `POST /v3/messages/{messageId}/update` — update app card | Typed Linq chat extension | Cohesive typed iMessage app-message API        | Missing    | Delivered outbound card only; serialize updates, inherit app identity, preserve new message IDs, and enforce iMessage-only behavior.                                                                                 | P2       | None                                                                                |
| `GET /v3/messages/{messageId}/poll`                      | Native Linq client        | `adapter.client.messages.poll.retrieve()`      | Client API | Poll workflow remains outside adapter semantics.                                                                                                                                                                     | —        | Endpoint behavior owned by Linq                                                     |
| `POST /v3/messages/{messageId}/poll/options`             | Native Linq client        | `adapter.client.messages.poll.addOptions()`    | Client API | Add-only poll options remain native-client behavior.                                                                                                                                                                 | —        | Endpoint behavior owned by Linq                                                     |
| `POST /v3/messages/{messageId}/poll/votes`               | Native Linq client        | `adapter.client.messages.poll.vote()`          | Client API | Vote workflow remains native-client-only.                                                                                                                                                                            | —        | Endpoint behavior owned by Linq                                                     |

### Payment requests

**Disposition:** Native Linq client. Request creation and management use
`adapter.client.paymentRequests`; no adapter payment facade is planned. Accepting payments over chat
is a recipe that composes those official-client operations with the adapter's general rich-link and
generic verified-event primitives.

| Linq operation                                        | Disposition        | Adapter API                                 | Status     | Limitations / completion gap                               | Priority | Test coverage                                                      |
| ----------------------------------------------------- | ------------------ | ------------------------------------------- | ---------- | ---------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `POST /v3/payment_requests`                           | Native Linq client | `adapter.client.paymentRequests.create()`   | Client API | Official client validation, idempotency, and errors apply. | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `GET /v3/payment_requests`                            | Native Linq client | `adapter.client.paymentRequests.list()`     | Client API | Official client pagination applies.                        | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `GET /v3/payment_requests/{paymentRequestId}`         | Native Linq client | `adapter.client.paymentRequests.retrieve()` | Client API | Official client state model applies.                       | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `POST /v3/payment_requests/{paymentRequestId}/cancel` | Native Linq client | `adapter.client.paymentRequests.cancel()`   | Client API | Official client cancellation semantics apply.              | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |

### Agentcard (boundary audit only)

**Boundary:** intentionally out of scope. The package will not support agents paying on customers'
behalf. These rows remain so the boundary audit does not hide this part of the Linq API; Batch `013`
will reconcile all newly added OpenAPI operations mechanically.

| Linq operation                                    | Disposition  | Adapter API    | Status       | Limitations / completion gap                                           | Priority | Test coverage |
| ------------------------------------------------- | ------------ | -------------- | ------------ | ---------------------------------------------------------------------- | -------- | ------------- |
| `POST /v3/payments/handles/{handle}/connect`      | Out of scope | None supported | Out of scope | Agentcard customer-handle connection is intentionally unsupported.     | —        | N/A           |
| `POST /v3/payments/handles/{handle}/verify`       | Out of scope | None supported | Out of scope | Agentcard customer verification is intentionally unsupported.          | —        | N/A           |
| `GET /v3/payments/handles/{handle}/connection`    | Out of scope | None supported | Out of scope | Agentcard customer-connection state is intentionally unsupported.      | —        | N/A           |
| `DELETE /v3/payments/handles/{handle}/connection` | Out of scope | None supported | Out of scope | Agentcard customer-connection revocation is intentionally unsupported. | —        | N/A           |
| `POST /v3/payments/providers/{provider}/connect`  | Out of scope | None supported | Out of scope | Agentcard provider onboarding is intentionally unsupported.            | —        | N/A           |
| `GET /v3/payments/providers/{provider}`           | Out of scope | None supported | Out of scope | Agentcard provider state is intentionally unsupported.                 | —        | N/A           |
| `POST /v3/payments`                               | Out of scope | None supported | Out of scope | Agent-initiated customer payments are intentionally unsupported.       | —        | N/A           |
| `GET /v3/payments/{paymentId}`                    | Out of scope | None supported | Out of scope | Agentcard payment retrieval is intentionally unsupported.              | —        | N/A           |
| `POST /v3/payments/{paymentId}/cancel`            | Out of scope | None supported | Out of scope | Agentcard payment cancellation is intentionally unsupported.           | —        | N/A           |
| `GET /v3/payments/{paymentId}/credentials`        | Out of scope | None supported | Out of scope | Agentcard credential handoff is intentionally unsupported.             | —        | N/A           |

### Phone numbers

**Disposition:** Native Linq client. Internal routing may consume
official-client data, but phone-number administration is not duplicated.

| Linq operation                                                   | Disposition        | Adapter API                                          | Status     | Limitations / completion gap                                            | Priority | Test coverage                                                      |
| ---------------------------------------------------------------- | ------------------ | ---------------------------------------------------- | ---------- | ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `GET /v3/phone_numbers`                                          | Native Linq client | `adapter.client.phoneNumbers.list()`                 | Client API | Official client schemas and errors apply.                               | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `PUT /v3/phone_numbers/{phoneNumberId}`                          | Native Linq client | `adapter.client.phoneNumbers.update()`               | Client API | Account configuration is not adapter behavior.                          | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `POST /v3/phone_numbers/{phoneNumber}/reputation_audit`          | Native Linq client | `adapter.client.phoneNumbers.startReputationAudit()` | Client API | Account health audit, not a chat abstraction.                           | —        | Endpoint behavior owned by Linq                                    |
| `GET /v3/phone_numbers/{phoneNumber}/reputation_audit/{auditId}` | Native Linq client | `adapter.client.phoneNumbers.getReputationAudit()`   | Client API | Polling and report semantics remain native-client behavior.             | —        | Endpoint behavior owned by Linq                                    |
| `GET /v3/phonenumbers` — deprecated list                         | Native Linq client | `adapter.client.phonenumbers.list()`                 | Deprecated | Use `/v3/phone_numbers`; no convenience API or operation-specific test. | —        | Native-client boundary contract only                               |

### Webhook administration

**Disposition:** Native Linq client. Runtime webhook verification and event dispatch
remain direct adapter scope and are tracked separately below.

| Linq operation                                      | Disposition        | Adapter API                                      | Status     | Limitations / completion gap                                 | Priority | Test coverage                                                      |
| --------------------------------------------------- | ------------------ | ------------------------------------------------ | ---------- | ------------------------------------------------------------ | -------- | ------------------------------------------------------------------ |
| `GET /v3/webhook-events`                            | Native Linq client | `adapter.client.webhookEvents.list()`            | Client API | Administrative discovery; also useful for maintaining audit. | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `POST /v3/webhook-subscriptions`                    | Native Linq client | `adapter.client.webhookSubscriptions.create()`   | Client API | Official client secret/version behavior applies.             | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `GET /v3/webhook-subscriptions`                     | Native Linq client | `adapter.client.webhookSubscriptions.list()`     | Client API | Official client response types apply.                        | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `GET /v3/webhook-subscriptions/{subscriptionId}`    | Native Linq client | `adapter.client.webhookSubscriptions.retrieve()` | Client API | Official client errors apply.                                | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `PUT /v3/webhook-subscriptions/{subscriptionId}`    | Native Linq client | `adapter.client.webhookSubscriptions.update()`   | Client API | Official client validation applies.                          | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `DELETE /v3/webhook-subscriptions/{subscriptionId}` | Native Linq client | `adapter.client.webhookSubscriptions.delete()`   | Client API | Official client deletion semantics apply.                    | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |

## Message feature parity

This section tracks message-model behavior that spans one or more endpoints.

| Message capability                         | Disposition                        | Adapter API                                                   | Status     | Constraints / limitations                                                                                                                                                                                                                     | Priority | Test coverage                                                      |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| Plain text parts                           | Standard Chat SDK mapping          | `thread.post(text)`                                           | Partial    | Existing-chat sends enforce non-empty/10,000-character limits, idempotency, SDK retry ownership, and shared provider errors. Initial proactive sends remain the Batch `004` native-client recipe; no adapter `openDM()` path is planned.      | P0       | Focused unit/contract + live `send`                                |
| Chat SDK markdown/AST                      | Standard Chat SDK mapping          | `thread.post({ markdown/ast })`                               | Partial    | Currently flattened to text; preserve faithfully representable formatting without leaking literal Markdown.                                                                                                                                   | P1       | Cards cover stripping; focused format contract missing             |
| Inline text styles                         | Standard mapping + typed extension | Standard formatted content + `LinqMessageOptions.decorations` | Missing    | Map standard bold/italic/strike AST to UTF-16 decorations; manual underline and explicit ranges use the shared options model.                                                                                                                 | P1       | None                                                               |
| Inline text animations                     | Typed Linq chat extension          | `LinqMessageOptions.decorations`                              | Missing    | Big/small/shake/nod/explode/ripple/bloom/jitter; animation ranges cannot overlap styles or other animations.                                                                                                                                  | P2       | None                                                               |
| Media by public HTTPS URL                  | Standard Chat SDK mapping          | `thread.post({ attachments })`                                | Partial    | Existing sends validate HTTPS and the 40-part sub-limit while preserving by-reference delivery; inbound download security/bounding is implemented, while complete formats and live failures remain incomplete.                                | P0       | Focused boundary/download unit + live `send`                       |
| Media by pre-uploaded attachment/raw bytes | Standard Chat SDK mapping          | `thread.post({ files })`                                      | Partial    | Existing sends enforce 1–255-character names and 1-byte–100MB uploads with preparation cleanup; readiness, upload retries, full formats, retention, and send-time lifecycle wait for Batch `012`.                                             | P0       | Focused boundary/cleanup unit + live `send`                        |
| Inbound media and fresh downloads          | Standard Chat SDK mapping          | `message.attachments` / `fetchData()`                         | Partial    | Bounded refresh/download works; ephemeral-tier/device and format-alias coverage remain.                                                                                                                                                       | P0       | Extensive unit; live none                                          |
| Rich link part                             | Typed Linq chat extension          | `linqMessage(content, { richLink })`                          | Missing    | Native preview part must stand alone; enforce HTTPS/length/content exclusivity before side effects and document SMS fallback.                                                                                                                 | P1       | None                                                               |
| Mixed and multipart messages               | Standard Chat SDK mapping          | `thread.post()`                                               | Partial    | Text followed by media enforces 100 total parts and 40 public URLs, including card images; richer alternating/native part inputs remain later work.                                                                                           | P1       | Focused boundary/contract unit + live text/media                   |
| Ordinary replies (`reply_to`)              | Standard Chat SDK mapping          | `thread.reply(messageOrId, content)`                          | Partial    | Implemented with canonical identity, explicit idempotency, and official SDK request placement. Provider/live reply threading and error evidence remain.                                                                                       | P1       | Unit + Chat SDK contract                                           |
| Part-index reply targeting                 | Typed Linq chat extension          | `adapter.conversation(threadOrId).replyToPart(...)`           | Missing    | Standard Chat SDK cannot carry `part_index`; validate zero/nonzero indexes, IDs, canonical identity, errors, edit compatibility, and inbound metadata.                                                                                        | P1       | Raw inbound preservation only                                      |
| Screen effects                             | Typed Linq chat extension          | `LinqMessageOptions.effect`                                   | Missing    | Closed enum; omitted service is best-effort, explicit iMessage is strict, and explicit RCS/SMS combinations reject before sending.                                                                                                            | P2       | None                                                               |
| Bubble effects                             | Typed Linq chat extension          | `LinqMessageOptions.effect`                                   | Missing    | Closed enum and one effect per message; follows the same approved protocol policy as screen effects.                                                                                                                                          | P2       | None                                                               |
| Preferred service                          | Typed Linq chat extension          | `LinqMessageOptions.preferredService`                         | Missing    | Omitted uses normal fallback; iMessage is strict; explicit RCS/SMS with effects, animations, or manual decorations rejects before side effects. No strictness option.                                                                         | P1       | None                                                               |
| Idempotency                                | Internal adapter behavior          | Standard existing-chat sends; native proactive recipe         | Partial    | Existing-chat `postMessage()` generates one UUID per logical call and the official SDK reuses it for retries. Proactive callers provide one key per logical `messages.create()` send; sandbox retry/concurrency evidence remains Batch `004`. | P0       | Existing-chat contract; proactive live validation planned          |
| Auto-selected sender/failover              | Native Linq client                 | `adapter.client.messages.create()`                            | Client API | Native response retains chosen line, reuse/new-chat result, previous chat, and failover reason. Batch `004` documents canonical handoff and validates provider behavior without an adapter wrapper.                                           | —        | Public-client contract; Batch `004` live validation                |
| Fixed-line chat creation                   | Native Linq client                 | `adapter.client.chats.create()`                               | Client API | Exact participant-set reuse, named-group semantics, and first-send restrictions stay on the official client. Guarded smoke tooling fails closed unless the returned owner and direct recipient match.                                         | —        | Unit + type; typed smoke contract + exact-line device send         |
| Native Name and Photo contact sharing      | Typed Linq chat extension          | `adapter.conversation(threadOrId).shareContactCard()`         | Missing    | Share the configured sending-number card in an existing iMessage conversation; configuration remains on client/dashboard.                                                                                                                     | P1       | None                                                               |
| Native voice-memo bubble                   | Typed Linq chat extension          | `adapter.conversation(threadOrId).sendVoiceMemo()`            | Missing    | Initially URL or existing attachment ID only; raw-byte/upload lifecycle waits for Batch `012`.                                                                                                                                                | P1       | Ordinary audio unit only                                           |
| Standard tapbacks                          | Standard Chat SDK mapping          | Standard reaction APIs/handlers                               | Partial    | Six tapbacks work both directions; outbound confirmation and live coverage remain.                                                                                                                                                            | P0       | Unit + inbound live                                                |
| Custom emoji reactions                     | Standard Chat SDK mapping          | Standard reaction APIs/handlers                               | Partial    | Standard custom emoji works; async failure correlation remains incomplete.                                                                                                                                                                    | P1       | Unit                                                               |
| Sticker reactions                          | Typed Linq chat extension          | Generic typed Linq event/raw attachment data                  | Missing    | Preserve inbound sticker metadata without inventing an emoji mapping. Outbound stickers are deferred until official SDK input support is unambiguous.                                                                                         | P2       | Current unit verifies it is ignored                                |
| Part-specific reactions                    | Typed Linq chat extension          | `adapter.conversation(threadOrId)` reaction options           | Missing    | Preserve `part_index` for add/remove and inbound events.                                                                                                                                                                                      | P2       | None                                                               |
| Edit text part                             | Standard Chat SDK mapping          | `SentMessage.edit()`                                          | Partial    | Standard part-0 edit only; validate outbound/time/count/text constraints. Arbitrary part editing remains on `adapter.client`.                                                                                                                 | P1       | Unit happy path                                                    |
| Delete Linq record                         | Native Linq client                 | `adapter.client.messages.delete()`                            | Client API | Storage deletion only, never recipient unsend.                                                                                                                                                                                                | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| Delivery/read/reconciliation state         | Typed Linq chat extension          | Generic typed `onLinqEvent` + metadata                        | Missing    | Preserve queued/sent/delivered/received/read/failed status and timestamps without domain workflow behavior.                                                                                                                                   | P0       | Retrieved parser has edited timestamp only                         |
| Apple Pay App Clip payment card            | Native Linq client                 | `adapter.client.chats.create()` / chat-message native methods | Client API | SDK `0.42.0` adds a standalone Linq checkout-link part that is iMessage-only and never downgrades. Inbound cards preserve the checkout URL as standard text/link plus the complete raw part; no payment-specific adapter API is planned.      | —        | Unit inbound normalization; endpoint behavior owned by Linq        |
| iMessage app part                          | Typed Linq chat extension          | Cohesive typed iMessage app-message API                       | Missing    | Must stand alone, requires a real Messages extension, and needs static fallback/layout validation.                                                                                                                                            | P2       | None                                                               |
| Update iMessage app card                   | Typed Linq chat extension          | Cohesive typed iMessage app-message API                       | Missing    | Delivered outbound card only; serialize updates and preserve new message identity.                                                                                                                                                            | P2       | None                                                               |
| Experience action                          | Native Linq client                 | `adapter.client.messages.create({ action })`                  | Client API | Experience discovery/action invocation is not a direct adapter priority.                                                                                                                                                                      | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| Chat SDK cards                             | Standard Chat SDK mapping          | `thread.post(<Card />)`                                       | Partial    | Text/images work; interactive controls remain labels unless a true iMessage app bridge exists.                                                                                                                                                | P1       | Extensive unit + live `cards`                                      |
| Streaming                                  | Standard Chat SDK mapping          | `thread.post(asyncIterable)`                                  | Partial    | Linq has no native stream; buffer internally to one final message and define structured-chunk behavior.                                                                                                                                       | P2       | Unit; no live timing test                                          |
| Message/history pagination direction       | Standard Chat SDK mapping          | `thread.messages` / `thread.allMessages`                      | Partial    | Retrieved `parts ?? []` fallback works. Mixed/all-tombstone pages must preserve order/cursor; malformed/null entries and null webhook parts must not abort. Direction remains incomplete.                                                     | P0       | No tombstone-page, malformed-part, or direction contract test      |
| Ephemeral message/attachment retention     | Internal adapter behavior          | Standard history/attachment behavior                          | Partial    | Refresh works; document visible retention behavior and cover ephemeral cleanup where available.                                                                                                                                               | P2       | Unit refresh only; live N/A unless enabled                         |
| Message limits and validation              | Internal adapter behavior          | All standard/extension send paths                             | Partial    | Existing-chat inputs centrally enforce emptiness, text, HTTPS, part/media counts, filenames, and upload sizes before side effects; richer-part, service, and Batch `012` lifecycle rules remain.                                              | P0       | Focused boundary and no-side-effect unit tests                     |

## Webhook parity

Target API for events without a Chat SDK equivalent:

```ts
const unsubscribe = adapter.onLinqEvent("message.delivered", async (event) => {
  // event is narrowed to MessageDeliveredWebhookEvent
});
```

`onLinqEvent()` must provide an overload for a single type, multiple types, and all events; return an
unsubscribe function; preserve the verified raw envelope; deduplicate on the provider event ID; and
never delay the webhook acknowledgement unnecessarily. Standard Chat SDK dispatch should still run
for message and reaction events where applicable.

All verified Linq events are eligible for lossless generic typed passthrough so consumers do not
lose subscribed events. Only standard message/reaction dispatch and true chat-native extensions
receive adapter-owned semantics. Payment Request events are consumed by a recipe; payment,
Agentcard, call, phone-administration, and other business workflows are not implemented here.

The current OpenAPI enum has 45 names. The adapter owns the event inventory because
`@linqapp/sdk@0.42.0` no longer exports an unwrap union. Batch `005` must use an adapter-owned event
map plus a lossless future-event form; poll rows authorize generic delivery only, not a workflow.

| Webhook event                   | Disposition               | Adapter API / behavior                        | Status       | Limitations / completion gap                                                                                                     | Priority | Test coverage                          |
| ------------------------------- | ------------------------- | --------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------- |
| `message.sent`                  | Typed Linq chat extension | Generic typed `onLinqEvent` + lifecycle data  | Missing      | Preserve verified outbound status/correlation without inventing a standard message event.                                        | P0       | None                                   |
| `message.received`              | Standard Chat SDK mapping | Standard message handlers + `onLinqEvent`     | Partial      | Standard dispatch works; direction, rich parts/status, and hostile payload coverage remain incomplete.                           | P0       | Unit + live `serve`                    |
| `message.read`                  | Typed Linq chat extension | Generic typed `onLinqEvent` + lifecycle data  | Missing      | Preserve service limits, timestamp, and message correlation.                                                                     | P0       | None                                   |
| `message.delivered`             | Typed Linq chat extension | Generic typed `onLinqEvent` + lifecycle data  | Missing      | Preserve service limits, timestamp, and message correlation.                                                                     | P0       | None                                   |
| `message.failed`                | Typed Linq chat extension | Generic typed `onLinqEvent` + failure data    | Missing      | Preserve provider code/reason/trace/retryability and correlation safely.                                                         | P0       | None                                   |
| `message.edited`                | Typed Linq chat extension | Generic typed `onLinqEvent` + refreshed state | Missing      | Must not dispatch as a new inbound message; preserve versioned payload.                                                          | P1       | None                                   |
| `reaction.added`                | Standard Chat SDK mapping | Standard `onReaction()` + `onLinqEvent`       | Partial      | Standard/custom reactions work; sticker/part-specific data needs lossless extension handling.                                    | P0       | Unit + live inbound                    |
| `reaction.removed`              | Standard Chat SDK mapping | Standard `onReaction()` + `onLinqEvent`       | Partial      | Same limitations as added reactions.                                                                                             | P0       | Unit + live inbound                    |
| `poll.received`                 | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                           | —        | N/A beyond generic passthrough         |
| `poll.failed`                   | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                           | —        | N/A beyond generic passthrough         |
| `poll.sent`                     | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                           | —        | N/A beyond generic passthrough         |
| `poll.delivered`                | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                           | —        | N/A beyond generic passthrough         |
| `poll.read`                     | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                           | —        | N/A beyond generic passthrough         |
| `poll.updated`                  | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                           | —        | N/A beyond generic passthrough         |
| `poll.vote.added`               | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                           | —        | N/A beyond generic passthrough         |
| `poll.vote.removed`             | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                           | —        | N/A beyond generic passthrough         |
| `poll.reaction.added`           | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                           | —        | N/A beyond generic passthrough         |
| `participant.added`             | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Preserve participant identity and refresh group metadata when needed.                                                            | P1       | None                                   |
| `participant.removed`           | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Distinguish participant removal from the sending line leaving.                                                                   | P1       | None                                   |
| `chat.created`                  | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Preserve chat identity/group metadata; no separate cache-warming public API.                                                     | P1       | None                                   |
| `chat.group_name_updated`       | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Observe typed group-management outcomes; do not promise exact request correlation without a provider key.                        | P1       | None                                   |
| `chat.group_icon_updated`       | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Observe typed group-management outcomes; do not promise exact request correlation without a provider key.                        | P1       | None                                   |
| `chat.group_name_update_failed` | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Preserve safe async failure reason/trace.                                                                                        | P1       | None                                   |
| `chat.group_icon_update_failed` | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Preserve safe async failure reason/trace.                                                                                        | P1       | None                                   |
| `chat.background_updated`       | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | No standard Chat SDK equivalent; retain full typed payload.                                                                      | P2       | None                                   |
| `chat.background_update_failed` | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Enum/prose exists but no authoritative payload schema/example; preserve authenticated `data` losslessly without invented fields. | P2       | Inventory drift coverage only          |
| `chat.typing_indicator.started` | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Chat SDK has no standard receive-typing handler.                                                                                 | P1       | None                                   |
| `chat.typing_indicator.stopped` | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Preserve sender/chat identity.                                                                                                   | P1       | None                                   |
| `phone_number.status_updated`   | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Preserve the envelope generically; no routing or phone-administration workflow behavior.                                         | —        | N/A beyond generic passthrough         |
| `call.initiated`                | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Call-domain workflow behavior is not adapter scope.                                                                              | —        | N/A beyond generic passthrough         |
| `call.ringing`                  | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Call-domain workflow behavior is not adapter scope.                                                                              | —        | N/A beyond generic passthrough         |
| `call.answered`                 | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Call-domain workflow behavior is not adapter scope.                                                                              | —        | N/A beyond generic passthrough         |
| `call.ended`                    | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Call-domain workflow behavior is not adapter scope.                                                                              | —        | N/A beyond generic passthrough         |
| `call.failed`                   | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Call-domain workflow behavior is not adapter scope.                                                                              | —        | N/A beyond generic passthrough         |
| `call.declined`                 | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Call-domain workflow behavior is not adapter scope.                                                                              | —        | N/A beyond generic passthrough         |
| `call.no_answer`                | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Call-domain workflow behavior is not adapter scope.                                                                              | —        | N/A beyond generic passthrough         |
| `location.sharing.started`      | Typed Linq chat extension | Generic typed `onLinqEvent` + location API    | Missing      | Event signals sharing state, not coordinates; preserve handle and guide polling.                                                 | P1       | None                                   |
| `location.sharing.stopped`      | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Preserve stop state and invalidate internal cached location state if any.                                                        | P1       | None                                   |
| `payment.succeeded`             | Recipe                    | Generic typed `onLinqEvent` passthrough       | Missing      | Payment-acceptance recipe may correlate the verified payload; adapter adds no payment semantics.                                 | —        | Generic passthrough + recipe docs only |
| `payment.canceled`              | Recipe                    | Generic typed `onLinqEvent` passthrough       | Missing      | Payment-acceptance recipe may correlate the verified payload; adapter adds no payment semantics.                                 | —        | Generic passthrough + recipe docs only |
| `payment.expired`               | Recipe                    | Generic typed `onLinqEvent` passthrough       | Missing      | Payment-acceptance recipe may correlate the verified payload; adapter adds no payment semantics.                                 | —        | Generic passthrough + recipe docs only |
| `payment.declined`              | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Agentcard-specific lifecycle behavior is intentionally unsupported.                                                              | —        | N/A beyond generic passthrough         |
| `payment.authorized`            | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Agentcard-specific lifecycle behavior is intentionally unsupported.                                                              | —        | N/A beyond generic passthrough         |
| `connection.created`            | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Agentcard connection workflows are intentionally unsupported.                                                                    | —        | N/A beyond generic passthrough         |
| `connection.revoked`            | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Agentcard connection workflows are intentionally unsupported.                                                                    | —        | N/A beyond generic passthrough         |

### Webhook transport behavior

| Capability                              | Disposition               | Adapter API                                      | Status   | Limitations / completion gap                                                                                                                                                  | Priority | Test coverage                                                  |
| --------------------------------------- | ------------------------- | ------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| Standard Webhooks verification          | Standard Chat SDK mapping | `chat.webhooks.linq(request)`                    | Complete | Adapter uses `standardwebhooks` directly. Standard is default; complete dual headers use configured authority; partial headers and failed-authority fallback are rejected.    | P0       | Comprehensive unit matrix; historical live `serve`             |
| Deprecated legacy verification          | Internal adapter behavior | `webhookVerificationMode: "legacy"`              | Partial  | Explicit migration mode only. Remove after known deployments migrate and Linq confirms no active legacy-secret requirement.                                                   | P0       | Legacy-only/dual/partial/timestamp/tamper unit contracts       |
| Replay protection                       | Internal adapter behavior | Standard/explicit-legacy boundary                | Complete | Five-minute boundary, exact authenticated body, reference constant-time Standard comparison, and constant-time legacy comparison.                                             | P0       | Boundary, stale, tamper, wrong-secret/ID, multi-signature unit |
| Versioned payload handling              | Internal adapter behavior | `verifyWebhook()` + standard path                | Complete | Current is normalized; older is lossless with narrow compatibility dispatch; future/unknown non-empty versions are lossless and acknowledged without current-schema dispatch. | P0       | Current/older/future/unknown/malformed unit contracts          |
| Unknown future events                   | Internal adapter behavior | Verified result + fast acknowledgement           | Partial  | Unknown current event names and unsupported versions preserve raw body/envelope; generic callbacks remain Batch `005`.                                                        | P0       | Unit verifies preservation and acknowledgement                 |
| Event deduplication                     | Internal adapter behavior | Chat SDK state + provider/partner/event identity | Missing  | Batch `005` atomically claims before callbacks, matching Chat SDK's at-most-once model. Durable application retries require persistence before dispatch.                      | P0       | None                                                           |
| Fast acknowledgement/background work    | Standard Chat SDK mapping | `WebhookOptions.waitUntil`                       | Partial  | Standard handlers receive options; Batch `005` must register generic callback work without unnecessarily delaying acknowledgement.                                            | P0       | Unit verifies current standard option forwarding               |
| Generic verified Linq event passthrough | Typed Linq chat extension | `onLinqEvent()` + verified dispatch              | Partial  | Verified raw ingress exists. One/many/all typed registration, lossless future events, dedupe, unsubscribe, and generic `waitUntil` scheduling remain planned in Batch `005`.  | P0       | Unit: verified ingress contract                                |
| Trusted webhook forwarding              | Internal adapter behavior | None                                             | Missing  | Deferred until an authenticated gateway use case exists; must preserve raw body, provenance, and explicit trust configuration.                                                | P2       | None                                                           |

## Recipes

Recipes introduce no adapter-specific workflow API and are not implementation batches. They are
published after their underlying native-client and chat primitives are stable.

### Accept payments over chat

**Disposition:** Recipe. **Status:** Missing; the public client boundary is complete, but the recipe
still waits on the general rich-link message extension and generic `onLinqEvent` passthrough.

1. Create, list, retrieve, or cancel a Payment Request with
   `adapter.client.paymentRequests`.
2. Send the returned `checkout_url` through the adapter's general rich-link message capability.
3. Subscribe to `payment.succeeded`, `payment.canceled`, and `payment.expired` with generic typed
   `adapter.onLinqEvent(...)`, correlating with Payment Request IDs/metadata in application code.

The application owns reconciliation, persistence, retries, customer/payment state, and any Stripe
subscription lifecycle. Linq owns Payment Request validation and endpoint errors. The adapter owns
only rich-link message fidelity and verified generic event delivery. Agentcard is never a fallback.

Coverage comes from the native-client boundary contract, rich-link chat-extension tests, and generic
event-passthrough tests. Add a recipe-level sandbox check only if it proves the cross-primitive
handoff without duplicating Linq's endpoint tests or charging a real customer.

## Implementation batches

Each batch should be independently reviewable, keep existing behavior working, contain no
Forma-specific assumptions, update this matrix, and satisfy the definition of done for the rows it
marks complete. Split a batch further if implementation or review scope grows.

Batch `000` is the completed consolidated dependency/contract/tooling reconciliation. The
documentation inventory is Batch `001`; it is not an implementation batch. Batch `004` is
retained as a reduced recipe/contract/live-validation batch and adds no runtime adapter behavior.
All runtime batches remain limited to adapter core, internal messaging behavior, a standard Chat SDK
mapping, or a genuine typed Linq chat extension.

| Batch | Disposition(s)                                     | Scope                           | Intended outcome                                                                                                                                                                                                                    |
| ----- | -------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `000` | Standard mapping + internal + native client        | Consolidated reconciliation     | **Complete.** Latest dependencies, adapter-owned Standard/explicit-legacy ingress, standard reply/read, typed fixtures, CI, OpenAPI inventory/drift checks, and reconciled guidance. No `005A` behavior.                            |
| `002` | Native Linq client                                 | Minimal public foundation       | **Complete.** Exported `LinqAdapter`, read-only `adapter.client: LinqAPIV3`, runtime identity/configuration tests, and compile-time contracts.                                                                                      |
| `003` | Standard mapping + internal behavior               | Reliable existing-chat sends    | **Complete.** Central current-input limits, UUID idempotency, trace-aware shared errors, SDK-owned send retries, preparation-only cleanup, and focused `thread.post()` contracts; Batch `012` retains the deferred media lifecycle. |
| `004` | Native Linq client + recipe                        | Proactive native-client handoff | **Planned documentation/contracts/live validation only.** Keep `openDM()` unsupported; use `messages.create()`, then construct `linq:{chatId}` from the returned canonical ID. No runtime adapter extension.                        |
| `005` | Standard mapping + internal + typed chat extension | Webhook/event foundation        | Preserve standard handlers while adding verified generic `onLinqEvent`, future-event delivery, dedupe, `waitUntil`, and fixtures without domain logic.                                                                              |
| `006` | Typed Linq chat extension                          | Message lifecycle               | **Planned immediately after `005`.** `006A` covers sent/delivered/read/failed contracts; `006B` covers edited/reconciled semantics, validation, docs, and live evidence without business workflows.                                 |
| `007` | Standard mapping + typed chat extension            | Non-lossy message model         | **Planned.** First prove and freeze the `linqMessage(content, options)` transport, then add rich links/replies/part fidelity. Forward history and outbound stickers retain explicit provider/SDK deferrals.                         |
| `008` | Typed Linq chat extension                          | Contact, presence, and voice    | **Planned.** Add `adapter.conversation(threadOrId)` and common operations; voice memos initially accept only public HTTPS URLs or existing attachment IDs.                                                                          |
| `009` | Typed Linq chat extension                          | Groups and location             | **Planned.** Add existing-group behavior under `.group`, location under `.location`, typed lifecycle events, constraints, and disposable sandbox/device validation.                                                                 |
| `010` | Standard mapping + typed chat extension            | Protocol, formatting, effects   | **Planned.** Share `LinqMessageOptions` with Batch `007`; map standard styles and add protocol/effect/animation behavior after the message transport is proven.                                                                     |
| `011` | Typed Linq chat extension                          | iMessage app messages           | **Deferred.** Experiences remain on `adapter.client`; no implementation is scheduled in the approved sequence.                                                                                                                      |
| `012` | Internal adapter behavior + standard mapping       | Media lifecycle                 | **Deferred.** Raw-byte voice memos and complete upload/readiness/format/refresh/retention/send-time lifecycle remain here; attachment administration stays on `adapter.client`.                                                     |
| `013` | Standard mapping + internal + typed chat extension | Remaining parity cleanup        | **Deferred.** The 68-operation/45-event mechanical refresh is complete in `000`; retain only later unresolved adapter-owned cleanup and future drift.                                                                               |

An implementation may be code-complete while its parity row remains `Partial`. Applicable Linq
sandbox and physical-device evidence is required before a row reaches `Complete`; record those
requirements and results in the affected parity rows.

Batch `002` requires no live sandbox or device test: it exposes an already-configured client
reference without calling an endpoint or adding device behavior. Linq owns operation-level live
coverage for native-client rows; the adapter boundary is covered by runtime identity/configuration
tests and compile-time public-surface contracts.

## Maintenance checks

Before merging any Linq SDK upgrade or OpenAPI-affecting PR:

1. Diff the canonical OpenAPI operation IDs and webhook event enum against this document.
2. Add every new operation, message property/variant, and event as `Missing` before implementation.
3. Verify removed/deprecated API remains documented with its migration path.
4. Assign every new row one of the six dispositions before proposing an API or batch.
5. Update disposition, status, limitations, priority, and test coverage in the same PR as a change.
6. Apply the rename litmus test: endpoint-shaped aliases stay on `adapter.client`.
7. Keep recipes outside implementation batches and out-of-scope rows outside APIs/examples/tests
   unless product scope is explicitly changed first.
