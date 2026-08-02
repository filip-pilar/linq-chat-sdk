# Linq feature parity

This document is the authoritative capability inventory and implementation backlog for the Linq
Chat SDK adapter. **Feature parity means complete, non-lossy coverage of Linq's chat and messaging
capabilities**, not a second wrapper around the entire Linq SDK.

The inventory still covers every operation in the Linq Partner API V3 OpenAPI document, every
message feature described by that API, and every subscribable webhook event. That full inventory is
a boundary audit: chat capabilities are adapter work; supported account, business, and
administrative operations remain official-client work reached through read-only `adapter.client`;
explicitly excluded capabilities remain inventory-only.

Sources of truth:

- [Linq documentation index](https://docs.linqapp.com/llms.txt)
- [Linq Partner API V3 OpenAPI document](https://cdn.linqapp.com/openapi/linq-api-v3.yaml)
- [`chat` adapter contract](https://chat-sdk.dev/docs/contributing/building)

Inventory snapshot: **2026-08-02**, with **57 HTTP operations** and **35 webhook event types**.
When the OpenAPI document changes, update this matrix before or in the same PR as adapter support.

Resolved and current npm client at this snapshot: **`@linqapp/sdk@0.32.1`**. The OpenAPI document is
ahead of that client for Experiences and Agentcard. Experience discovery remains native-client-only and
waits for official client support. Agentcard is intentionally out of scope regardless of future
client support; do not bridge either gap with hand-written adapter HTTP wrappers.

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
   `thread.post()`, `thread.messages`, `thread.startTyping()`, message edit/reactions, and standard
   message/reaction handlers. Future Batch `004` may add `chat.openDM()` support only after its
   design gate; proactive sending is not supported by the adapter today.
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
| Proactive send/chat creation | Standard mapping + internal behavior         | Missing       | Batch `004` after its identity/atomic-send design gate                  |
| Webhooks                     | Standard + internal + typed chat extension   | Partial       | Generic typed passthrough, dedupe, then chat lifecycle fidelity         |
| Contact sharing/read/voice   | Typed Linq chat extension                    | Partial       | Share configured Name and Photo card; presence/voice device tests       |
| Groups and location          | Typed Linq chat extension                    | Partial       | Cohesive chat APIs, lifecycle events, and sandbox tests                 |
| Rich messaging               | Standard mapping + typed Linq chat extension | Partial       | Formatting, links, replies, protocol/effects, iMessage app messages     |
| Native client boundary       | Native Linq client                           | Complete      | Batch `002`: exported `LinqAdapter` + read-only, identity-tested client |

Recipes are tracked separately from implementation work; see [Recipes](#recipes).

### Batch `004` proactive-send design gate

Proactive sending is unsupported by the adapter today. `chat.openDM()` returns a thread before the
caller supplies content to `thread.post()`, while Linq creates or reuses a chat only as part of an
initial-message send. The existing adapter therefore sends only to canonical `linq:{chatId}` threads.

Applications that need proactive sending now must call the official client through read-only
`adapter.client`: use `adapter.client.messages.create()` for Linq's auto-selected sending number, or
`adapter.client.chats.create()` when the application must choose the sending number explicitly.
These are native-client calls, not adapter behavior. Do not add `adapter.sendMessage()`,
`adapter.createChat()`, endpoint-shaped aliases, or parallel request/result types.

Batch `004` may add a standard Chat SDK proactive path only after its implementation plan and tests
resolve all of these acceptance gates:

1. Preserve one stable thread identity across `openDM()`, the first post, returned messages, inbound
   webhooks, history, subscriptions, and process restarts without splitting state between a
   provisional recipient ID and the canonical Linq chat ID.
2. Preserve compatibility with existing `linq:{chatId}` and legacy thread IDs; document and test any
   unavoidable migration before changing their meaning.
3. Make concurrent first posts and transport retries side-effect safe: create/send exactly the
   intended messages, reuse one idempotency value per logical send, and never create placeholder
   messages solely to obtain a chat ID.
4. Apply the existing outbound validation, error, attachment, retry-ownership, and cleanup contracts
   before Linq side effects, plus verified new-chat restrictions for links, replies, effects, service
   selection, and any other initial-message-only behavior.
5. Preserve the auto-selected endpoint's exclusions, continuation inputs, chosen sending number,
   reused/new-chat result, previous chat, failover reason, and stable errors without exposing a
   provider-shaped adapter API. Keep explicit fixed-line creation on `adapter.client.chats.create()`.
6. Define behavior before and after the first send for fetching thread/history, typing, reactions,
   edits, subscriptions, and subsequent posts; unsupported pre-send operations must fail clearly and
   without side effects.
7. Add focused unit and Chat SDK contract coverage for creation, reuse, concurrency, retries, errors,
   and identity convergence, plus applicable sandbox/device assertions for new-chat, existing-chat,
   sender-selection, and failover behavior.

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

### Chats

| Linq operation                                                | Disposition               | Adapter API                                                             | Status     | Limitations / completion gap                                                                                                                                                                                                                     | Priority | Test coverage                                                              |
| ------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------- |
| `POST /v3/chats` — create chat with initial message           | Internal adapter behavior | Future standard proactive path; current `adapter.client.chats.create()` | Missing    | The adapter does not create chats today. Batch `004` must satisfy its design gate before using this endpoint internally. Explicit fixed-line creation remains on the native client; do not add `adapter.createChat()`.                           | P0       | None                                                                       |
| `GET /v3/chats` — list chats                                  | Native Linq client        | `adapter.client.chats.listChats()`                                      | Client API | Chat SDK has no faithful chat-list contract; do not add `adapter.listChats()`.                                                                                                                                                                   | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq         |
| `GET /v3/chats/{chatId}` — retrieve chat                      | Internal adapter behavior | Standard thread construction/refresh                                    | Partial    | Internal mapping works and preserves raw metadata; not-found and live coverage remain incomplete.                                                                                                                                                | P0       | Unit: thread/identity cases in `adapter.test.ts`; live: indirect           |
| `PUT /v3/chats/{chatId}` — update group name/icon             | Typed Linq chat extension | Cohesive typed group-management API                                     | Missing    | Group-only native conversation behavior; async success/failure correlation and public HTTPS icon validation required.                                                                                                                            | P1       | None                                                                       |
| `POST /v3/chats/{chatId}/leave` — leave group                 | Typed Linq chat extension | Cohesive typed group-management API                                     | Missing    | Group/member minimums, post-leave behavior, participant correlation, and disposable-group live coverage required.                                                                                                                                | P2       | None                                                                       |
| `GET /v3/chats/{chatId}/location` — get shared locations      | Typed Linq chat extension | Cohesive typed location API                                             | Missing    | GeoJSON order, freshness, handle matching, empty results, and polling guidance required.                                                                                                                                                         | P1       | None                                                                       |
| `POST /v3/chats/{chatId}/location/request`                    | Typed Linq chat extension | Cohesive typed location API                                             | Missing    | One-to-one iMessage constraints, consent, and asynchronous sharing lifecycle required.                                                                                                                                                           | P1       | None                                                                       |
| `POST /v3/chats/{chatId}/messages` — send to existing chat    | Standard Chat SDK mapping | `thread.post()`                                                         | Partial    | Current text/media/cards have central limits, per-call idempotency, SDK-owned retries, shared errors, and a `thread.post()` contract; rich links, replies, effects, protocol selection, full formatting, and Batch `012` media lifecycle remain. | P0       | Unit: text/media/cards plus `outbound-send.test.ts`; live: `send`, `cards` |
| `GET /v3/chats/{chatId}/messages` — list chat messages        | Standard Chat SDK mapping | `thread.messages` / `thread.allMessages`                                | Partial    | Cursor/limit work; direction, rich-part/status normalization, and live pagination remain incomplete.                                                                                                                                             | P0       | Unit: parser only; no pagination contract/live test                        |
| `POST /v3/chats/{chatId}/participants` — add participant      | Typed Linq chat extension | Cohesive typed group-management API                                     | Missing    | iMessage group-only constraints, limits, handle validation, and event correlation required.                                                                                                                                                      | P1       | None                                                                       |
| `DELETE /v3/chats/{chatId}/participants` — remove participant | Typed Linq chat extension | Cohesive typed group-management API                                     | Missing    | iMessage group-only constraints, minimum size, self-removal distinction, and event correlation required.                                                                                                                                         | P1       | None                                                                       |
| `POST /v3/chats/{chatId}/read` — mark read                    | Typed Linq chat extension | Typed conversation-state API                                            | Missing    | No standard Chat SDK equivalent; one-to-one/service constraints and idempotence need docs/tests.                                                                                                                                                 | P1       | None                                                                       |
| `POST /v3/chats/{chatId}/share_contact_card`                  | Typed Linq chat extension | Typed native contact-card sharing API                                   | Missing    | Shares the sending number's configured Name and Photo card so an iMessage recipient can save it; configuration remains on `adapter.client`/dashboard.                                                                                            | P1       | None                                                                       |
| `POST /v3/chats/{chatId}/typing` — start typing               | Standard Chat SDK mapping | `thread.startTyping()`                                                  | Partial    | DM start works; long-work refresh, stable error semantics, and live duration remain incomplete.                                                                                                                                                  | P1       | Unit: typing cases in `adapter.test.ts`; live: indirect                    |
| `DELETE /v3/chats/{chatId}/typing` — stop typing              | Typed Linq chat extension | Typed conversation-state API                                            | Missing    | Chat SDK has no stop method; document automatic clear-on-send/timeout and avoid a raw endpoint alias.                                                                                                                                            | P2       | None                                                                       |
| `POST /v3/chats/{chatId}/voicememo`                           | Typed Linq chat extension | Typed native voice-memo API                                             | Missing    | Ordinary audio files are not equivalent; formats, size, URL/upload inputs, and RCS/SMS behavior need tests.                                                                                                                                      | P1       | Unit: ordinary audio only; live: none                                      |

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

| Linq operation                                           | Disposition               | Adapter API                                                                | Status     | Limitations / completion gap                                                                                                                                                                                           | Priority | Test coverage                                                                       |
| -------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `GET /v3/experiences` — list invokable experiences       | Native Linq client        | `adapter.client` (official method pending)                                 | Missing    | Absent from `@linqapp/sdk@0.32.1`; wait for official codegen and add no wrapper.                                                                                                                                       | —        | Native-client version/boundary contract only                                        |
| `GET /v3/experiences/{experience}`                       | Native Linq client        | `adapter.client` (official method pending)                                 | Missing    | Absent from `@linqapp/sdk@0.32.1`; wait for official codegen and add no wrapper.                                                                                                                                       | —        | Native-client version/boundary contract only                                        |
| `POST /v3/messages` — auto-selected sender               | Internal adapter behavior | Future standard proactive path; current `adapter.client.messages.create()` | Missing    | The adapter does not send proactively today. Batch `004` must preserve exclusions, continuation, chosen line, reuse/new-chat result, previous chat, failover reason, and idempotency after satisfying its design gate. | P0       | None                                                                                |
| `GET /v3/messages/{messageId}`                           | Internal adapter behavior | Standard message/history/refresh behavior                                  | Partial    | Parsing works; delivery/reaction/rich-part normalization, error/trace contracts, and live coverage are incomplete.                                                                                                     | P0       | Unit: retrieved-message parser cases in `adapter.test.ts`                           |
| `PATCH /v3/messages/{messageId}` — edit text part        | Standard Chat SDK mapping | `SentMessage.edit()`                                                       | Partial    | Part 0 works; outbound-only, time/edit-count, text-part, and part-index constraints need stable handling.                                                                                                              | P1       | Unit: part-0 happy path only; live: none                                            |
| `DELETE /v3/messages/{messageId}` — delete Linq record   | Native Linq client        | `adapter.client.messages.delete()`                                         | Client API | Storage deletion is not recipient unsend and must never back Chat SDK `SentMessage.delete()`.                                                                                                                          | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq                  |
| `POST /v3/messages/{messageId}/reactions`                | Standard Chat SDK mapping | `SentMessage.addReaction()`/`removeReaction()`                             | Partial    | Standard/custom emoji work; part-specific/sticker behavior and async error/live coverage remain incomplete.                                                                                                            | P0       | Unit: `reactions.test.ts`, adapter webhook cases; live: inbound reaction in `serve` |
| `GET /v3/messages/{messageId}/thread`                    | Native Linq client        | `adapter.client.messages.listMessagesThread()`                             | Client API | Linq reply threads do not match Chat SDK conversation threads; avoid an endpoint-shaped wrapper.                                                                                                                       | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq                  |
| `POST /v3/messages/{messageId}/update` — update app card | Typed Linq chat extension | Cohesive typed iMessage app-message API                                    | Missing    | Delivered outbound card only; serialize updates, inherit app identity, preserve new message IDs, and enforce iMessage-only behavior.                                                                                   | P2       | None                                                                                |

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
behalf. These rows remain only so the 57-operation audit does not hide part of the Linq API.

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

| Linq operation                           | Disposition        | Adapter API                            | Status     | Limitations / completion gap                                            | Priority | Test coverage                                                      |
| ---------------------------------------- | ------------------ | -------------------------------------- | ---------- | ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `GET /v3/phone_numbers`                  | Native Linq client | `adapter.client.phoneNumbers.list()`   | Client API | Official client schemas and errors apply.                               | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `PUT /v3/phone_numbers/{phoneNumberId}`  | Native Linq client | `adapter.client.phoneNumbers.update()` | Client API | Account configuration is not adapter behavior.                          | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| `GET /v3/phonenumbers` — deprecated list | Native Linq client | `adapter.client.phonenumbers.list()`   | Deprecated | Use `/v3/phone_numbers`; no convenience API or operation-specific test. | —        | Native-client boundary contract only                               |

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

| Message capability                         | Disposition               | Adapter API                                                                | Status     | Constraints / limitations                                                                                                                                                                                                                           | Priority | Test coverage                                                      |
| ------------------------------------------ | ------------------------- | -------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| Plain text parts                           | Standard Chat SDK mapping | `thread.post(text)`                                                        | Partial    | Existing-chat sends enforce non-empty/10,000-character limits, idempotency, SDK retry ownership, and shared provider errors. Adapter-level proactive sends are unsupported today and wait for Batch `004`; native-client sending remains available. | P0       | Focused unit/contract + live `send`                                |
| Chat SDK markdown/AST                      | Standard Chat SDK mapping | `thread.post({ markdown/ast })`                                            | Partial    | Currently flattened to text; preserve faithfully representable formatting without leaking literal Markdown.                                                                                                                                         | P1       | Cards cover stripping; focused format contract missing             |
| Inline text styles                         | Standard Chat SDK mapping | Standard formatted content                                                 | Missing    | Map representable bold/italic/strike/underline to UTF-16 decorations internally; no Linq-specific style API.                                                                                                                                        | P1       | None                                                               |
| Inline text animations                     | Typed Linq chat extension | Cohesive typed Linq message options                                        | Missing    | Big/small/shake/nod/explode/ripple/bloom/jitter; ranges cannot overlap styles/animations.                                                                                                                                                           | P2       | None                                                               |
| Media by public HTTPS URL                  | Standard Chat SDK mapping | `thread.post({ attachments })`                                             | Partial    | Existing sends validate HTTPS and the 40-part sub-limit while preserving by-reference delivery; download security/bounding, full formats, and live failures wait for Batch `012`.                                                                   | P0       | Focused boundary unit + live `send`                                |
| Media by pre-uploaded attachment/raw bytes | Standard Chat SDK mapping | `thread.post({ files })`                                                   | Partial    | Existing sends enforce 1–255-character names and 1-byte–100MB uploads with preparation cleanup; readiness, upload retries, full formats, retention, and send-time lifecycle wait for Batch `012`.                                                   | P0       | Focused boundary/cleanup unit + live `send`                        |
| Inbound media and fresh downloads          | Standard Chat SDK mapping | `message.attachments` / `fetchData()`                                      | Partial    | Bounded refresh/download works; ephemeral-tier/device and format-alias coverage remain.                                                                                                                                                             | P0       | Extensive unit; live none                                          |
| Rich link part                             | Typed Linq chat extension | Cohesive typed Linq message input                                          | Missing    | Native preview part must stand alone; enforce URL/service/first-message constraints and SMS fallback.                                                                                                                                               | P1       | None                                                               |
| Mixed and multipart messages               | Standard Chat SDK mapping | `thread.post()`                                                            | Partial    | Text followed by media enforces 100 total parts and 40 public URLs, including card images; richer alternating/native part inputs remain later work.                                                                                                 | P1       | Focused boundary/contract unit + live text/media                   |
| Replies (`reply_to`)                       | Typed Linq chat extension | Cohesive typed Linq message options                                        | Missing    | Preserve optional part index; disallow on new chats; normalize inbound reply metadata beyond `raw`.                                                                                                                                                 | P1       | Raw preservation unit only                                         |
| Screen effects                             | Typed Linq chat extension | Cohesive typed Linq message options                                        | Missing    | Validate supported effect enum and iMessage-only behavior.                                                                                                                                                                                          | P2       | None                                                               |
| Bubble effects                             | Typed Linq chat extension | Cohesive typed Linq message options                                        | Missing    | Validate slam/loud/gentle/invisible, one effect per message, and iMessage-only behavior.                                                                                                                                                            | P2       | None                                                               |
| Preferred service                          | Typed Linq chat extension | Cohesive typed Linq message options                                        | Missing    | `iMessage`, `RCS`, or `SMS`; reject incompatible rich features clearly.                                                                                                                                                                             | P1       | None                                                               |
| Idempotency                                | Internal adapter behavior | Standard send paths                                                        | Partial    | Existing-chat `postMessage()` generates one UUID per logical call and the official SDK reuses it for retries. Adapter-level proactive sending is unsupported today and waits for Batch `004`; no separate public idempotency API is planned.        | P0       | Existing-chat focused unit/contract                                |
| Auto-selected sender/failover              | Internal adapter behavior | Future standard proactive path; current `adapter.client.messages.create()` | Missing    | Batch `004` must preserve exclusions, continuation, chosen line, reuse/new-chat result, previous chat, failover reason, and idempotency internally after satisfying its design gate.                                                                | P0       | None                                                               |
| Fixed-line chat creation                   | Native Linq client        | `adapter.client.chats.create()`                                            | Client API | Exact participant-set reuse, named-group semantics, and first-send restrictions stay on the official client.                                                                                                                                        | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| Native Name and Photo contact sharing      | Typed Linq chat extension | Typed native contact-card sharing API                                      | Missing    | Share the configured sending-number card in an existing iMessage conversation; configuration remains on client/dashboard.                                                                                                                           | P1       | None                                                               |
| Native voice-memo bubble                   | Typed Linq chat extension | Typed native voice-memo API                                                | Missing    | Dedicated native bubble; normal audio attachments are not equivalent.                                                                                                                                                                               | P1       | Ordinary audio unit only                                           |
| Standard tapbacks                          | Standard Chat SDK mapping | Standard reaction APIs/handlers                                            | Partial    | Six tapbacks work both directions; outbound confirmation and live coverage remain.                                                                                                                                                                  | P0       | Unit + inbound live                                                |
| Custom emoji reactions                     | Standard Chat SDK mapping | Standard reaction APIs/handlers                                            | Partial    | Standard custom emoji works; async failure correlation remains incomplete.                                                                                                                                                                          | P1       | Unit                                                               |
| Sticker reactions                          | Typed Linq chat extension | Generic typed Linq event/raw attachment data                               | Missing    | No Chat SDK emoji equivalent; preserve sticker metadata and attachment access without inventing an emoji mapping.                                                                                                                                   | P2       | Current unit verifies it is ignored                                |
| Part-specific reactions                    | Typed Linq chat extension | Cohesive typed Linq reaction options                                       | Missing    | Preserve `part_index` for add/remove and inbound events.                                                                                                                                                                                            | P2       | None                                                               |
| Edit text part                             | Standard Chat SDK mapping | `SentMessage.edit()`                                                       | Partial    | Standard part-0 edit only; validate outbound/time/count/text constraints. Arbitrary part editing remains on `adapter.client`.                                                                                                                       | P1       | Unit happy path                                                    |
| Delete Linq record                         | Native Linq client        | `adapter.client.messages.delete()`                                         | Client API | Storage deletion only, never recipient unsend.                                                                                                                                                                                                      | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| Delivery/read/reconciliation state         | Typed Linq chat extension | Generic typed `onLinqEvent` + metadata                                     | Missing    | Preserve queued/sent/delivered/received/read/failed status and timestamps without domain workflow behavior.                                                                                                                                         | P0       | Retrieved parser has edited timestamp only                         |
| iMessage app part                          | Typed Linq chat extension | Cohesive typed iMessage app-message API                                    | Missing    | Must stand alone, requires a real Messages extension, and needs static fallback/layout validation.                                                                                                                                                  | P2       | None                                                               |
| Update iMessage app card                   | Typed Linq chat extension | Cohesive typed iMessage app-message API                                    | Missing    | Delivered outbound card only; serialize updates and preserve new message identity.                                                                                                                                                                  | P2       | None                                                               |
| Experience action                          | Native Linq client        | `adapter.client.messages.create({ action })`                               | Client API | Experience discovery/action invocation is not a direct adapter priority.                                                                                                                                                                            | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq |
| Chat SDK cards                             | Standard Chat SDK mapping | `thread.post(<Card />)`                                                    | Partial    | Text/images work; interactive controls remain labels unless a true iMessage app bridge exists.                                                                                                                                                      | P1       | Extensive unit + live `cards`                                      |
| Streaming                                  | Standard Chat SDK mapping | `thread.post(asyncIterable)`                                               | Partial    | Linq has no native stream; buffer internally to one final message and define structured-chunk behavior.                                                                                                                                             | P2       | Unit; no live timing test                                          |
| Message/history pagination direction       | Standard Chat SDK mapping | `thread.messages` / `thread.allMessages`                                   | Partial    | Cursor/chronological output exists; forward/backward direction is not passed faithfully.                                                                                                                                                            | P0       | No direction contract test                                         |
| Ephemeral message/attachment retention     | Internal adapter behavior | Standard history/attachment behavior                                       | Partial    | Refresh works; document visible retention behavior and cover ephemeral cleanup where available.                                                                                                                                                     | P2       | Unit refresh only; live N/A unless enabled                         |
| Message limits and validation              | Internal adapter behavior | All standard/extension send paths                                          | Partial    | Existing-chat inputs centrally enforce emptiness, text, HTTPS, part/media counts, filenames, and upload sizes before side effects; first-message, richer-part, service, and Batch `012` lifecycle rules remain.                                     | P0       | Focused boundary and no-side-effect unit tests                     |

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

| Webhook event                   | Disposition               | Adapter API / behavior                        | Status       | Limitations / completion gap                                                                           | Priority | Test coverage                          |
| ------------------------------- | ------------------------- | --------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------- |
| `message.sent`                  | Typed Linq chat extension | Generic typed `onLinqEvent` + lifecycle data  | Missing      | Preserve verified outbound status/correlation without inventing a standard message event.              | P0       | None                                   |
| `message.received`              | Standard Chat SDK mapping | Standard message handlers + `onLinqEvent`     | Partial      | Standard dispatch works; direction, rich parts/status, and hostile payload coverage remain incomplete. | P0       | Unit + live `serve`                    |
| `message.read`                  | Typed Linq chat extension | Generic typed `onLinqEvent` + lifecycle data  | Missing      | Preserve service limits, timestamp, and message correlation.                                           | P0       | None                                   |
| `message.delivered`             | Typed Linq chat extension | Generic typed `onLinqEvent` + lifecycle data  | Missing      | Preserve service limits, timestamp, and message correlation.                                           | P0       | None                                   |
| `message.failed`                | Typed Linq chat extension | Generic typed `onLinqEvent` + failure data    | Missing      | Preserve provider code/reason/trace/retryability and correlation safely.                               | P0       | None                                   |
| `message.edited`                | Typed Linq chat extension | Generic typed `onLinqEvent` + refreshed state | Missing      | Must not dispatch as a new inbound message; preserve versioned payload.                                | P1       | None                                   |
| `reaction.added`                | Standard Chat SDK mapping | Standard `onReaction()` + `onLinqEvent`       | Partial      | Standard/custom reactions work; sticker/part-specific data needs lossless extension handling.          | P0       | Unit + live inbound                    |
| `reaction.removed`              | Standard Chat SDK mapping | Standard `onReaction()` + `onLinqEvent`       | Partial      | Same limitations as added reactions.                                                                   | P0       | Unit + live inbound                    |
| `participant.added`             | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Preserve participant identity and refresh group metadata when needed.                                  | P1       | None                                   |
| `participant.removed`           | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Distinguish participant removal from the sending line leaving.                                         | P1       | None                                   |
| `chat.created`                  | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Preserve chat identity/group metadata; no separate cache-warming public API.                           | P1       | None                                   |
| `chat.group_name_updated`       | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Correlate typed group-management requests.                                                             | P1       | None                                   |
| `chat.group_icon_updated`       | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Correlate typed group-management requests.                                                             | P1       | None                                   |
| `chat.group_name_update_failed` | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Preserve safe async failure reason/trace.                                                              | P1       | None                                   |
| `chat.group_icon_update_failed` | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Preserve safe async failure reason/trace.                                                              | P1       | None                                   |
| `chat.background_updated`       | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | No standard Chat SDK equivalent; retain full typed payload.                                            | P2       | None                                   |
| `chat.typing_indicator.started` | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Chat SDK has no standard receive-typing handler.                                                       | P1       | None                                   |
| `chat.typing_indicator.stopped` | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Preserve sender/chat identity.                                                                         | P1       | None                                   |
| `phone_number.status_updated`   | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Preserve the envelope generically; no routing or phone-administration workflow behavior.               | —        | N/A beyond generic passthrough         |
| `call.initiated`                | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Call-domain workflow behavior is not adapter scope.                                                    | —        | N/A beyond generic passthrough         |
| `call.ringing`                  | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Call-domain workflow behavior is not adapter scope.                                                    | —        | N/A beyond generic passthrough         |
| `call.answered`                 | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Call-domain workflow behavior is not adapter scope.                                                    | —        | N/A beyond generic passthrough         |
| `call.ended`                    | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Call-domain workflow behavior is not adapter scope.                                                    | —        | N/A beyond generic passthrough         |
| `call.failed`                   | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Call-domain workflow behavior is not adapter scope.                                                    | —        | N/A beyond generic passthrough         |
| `call.declined`                 | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Call-domain workflow behavior is not adapter scope.                                                    | —        | N/A beyond generic passthrough         |
| `call.no_answer`                | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Call-domain workflow behavior is not adapter scope.                                                    | —        | N/A beyond generic passthrough         |
| `location.sharing.started`      | Typed Linq chat extension | Generic typed `onLinqEvent` + location API    | Missing      | Event signals sharing state, not coordinates; preserve handle and guide polling.                       | P1       | None                                   |
| `location.sharing.stopped`      | Typed Linq chat extension | Generic typed `onLinqEvent`                   | Missing      | Preserve stop state and invalidate internal cached location state if any.                              | P1       | None                                   |
| `payment.succeeded`             | Recipe                    | Generic typed `onLinqEvent` passthrough       | Missing      | Payment-acceptance recipe may correlate the verified payload; adapter adds no payment semantics.       | —        | Generic passthrough + recipe docs only |
| `payment.canceled`              | Recipe                    | Generic typed `onLinqEvent` passthrough       | Missing      | Payment-acceptance recipe may correlate the verified payload; adapter adds no payment semantics.       | —        | Generic passthrough + recipe docs only |
| `payment.expired`               | Recipe                    | Generic typed `onLinqEvent` passthrough       | Missing      | Payment-acceptance recipe may correlate the verified payload; adapter adds no payment semantics.       | —        | Generic passthrough + recipe docs only |
| `payment.declined`              | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Agentcard-specific lifecycle behavior is intentionally unsupported.                                    | —        | N/A beyond generic passthrough         |
| `payment.authorized`            | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Agentcard-specific lifecycle behavior is intentionally unsupported.                                    | —        | N/A beyond generic passthrough         |
| `connection.created`            | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Agentcard connection workflows are intentionally unsupported.                                          | —        | N/A beyond generic passthrough         |
| `connection.revoked`            | Out of scope              | Generic typed `onLinqEvent` passthrough only  | Out of scope | Agentcard connection workflows are intentionally unsupported.                                          | —        | N/A beyond generic passthrough         |

### Webhook transport behavior

| Capability                              | Disposition               | Adapter API                                     | Status   | Limitations / completion gap                                                                                                                                         | Priority | Test coverage                                                    |
| --------------------------------------- | ------------------------- | ----------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| Standard Webhooks verification          | Standard Chat SDK mapping | `chat.webhooks.linq(request)`                   | Complete | Official verification plus legacy compatibility; invalid JSON and downgrade cases covered.                                                                           | P0       | Unit: `adapter.test.ts`; live: `serve`                           |
| Replay protection                       | Internal adapter behavior | Standard webhook path                           | Complete | Five-minute timestamp window and constant-time legacy signature comparison.                                                                                          | P0       | Unit                                                             |
| Versioned payload handling              | Internal adapter behavior | `verifyWebhook()` + standard path               | Complete | The typed path accepts only `2026-02-03` and reports unsupported versions; the standard path retains older-version compatibility without typed coercion.             | P0       | Current, malformed, unsupported, and compatibility unit fixtures |
| Unknown future events                   | Internal adapter behavior | Verified result + fast acknowledgement          | Partial  | The two-phase API preserves the complete verified envelope as `unhandled`; the one-step path still acknowledges without an event callback.                           | P0       | Unit verifies and acknowledges unknown events                    |
| Event deduplication                     | Internal adapter behavior | Chat SDK state + provider `event_id`            | Missing  | Contract-test dedupe keys and retry behavior for every dispatch path.                                                                                                | P0       | None                                                             |
| Fast acknowledgement/background work    | Standard Chat SDK mapping | `WebhookOptions.waitUntil`                      | Partial  | Standard handlers receive options; generic event handlers need the same timing policy.                                                                               | P0       | Unit verifies option forwarding through both webhook paths       |
| Generic verified Linq event passthrough | Typed Linq chat extension | `verifyWebhook()` / `dispatchVerifiedWebhook()` | Partial  | Consumers can durably inspect every current-version verified envelope before optional standard dispatch; typed per-event callbacks and deduplication remain planned. | P0       | Unit: verified ingress contract                                  |

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

The documentation inventory is Batch `001`; it is not an implementation batch. Every batch below is
limited to adapter core, internal messaging behavior, a standard Chat SDK mapping, or a genuine
typed Linq chat extension. Recipes and endpoint-shaped native-client operations never get a batch.

| Batch | Disposition(s)                                     | Scope                         | Intended outcome                                                                                                                                                                                                                                               |
| ----- | -------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `002` | Native Linq client                                 | Minimal public foundation     | **Complete.** Exported `LinqAdapter`, read-only `adapter.client: LinqAPIV3`, runtime identity/configuration tests, and compile-time contracts.                                                                                                                 |
| `003` | Standard mapping + internal behavior               | Reliable existing-chat sends  | **Complete.** Central current-input limits, UUID idempotency, trace-aware shared errors, SDK-owned send retries, preparation-only cleanup, and focused `thread.post()` contracts; Batch `012` retains the deferred media lifecycle.                            |
| `004` | Standard mapping + internal behavior               | Proactive Chat SDK send       | **Unsupported today; design-gated.** After satisfying the proactive-send acceptance gates above, implement a compatible standard `openDM()`/proactive path with internal auto-selection/failover and no `sendMessage()` or `createChat()` convenience wrapper. |
| `005` | Standard mapping + internal + typed chat extension | Webhook/event foundation      | Preserve standard handlers while adding verified generic `onLinqEvent`, future-event delivery, dedupe, `waitUntil`, and fixtures without domain logic.                                                                                                         |
| `006` | Typed Linq chat extension                          | Message lifecycle             | Preserve sent/delivered/read/failed/edited state and typed chat events without adding business workflows.                                                                                                                                                      |
| `007` | Standard mapping + typed chat extension            | Non-lossy message model       | Complete standard formatting/cards/history plus cohesive rich-link, reply, sticker, and part-specific options with live device assertions.                                                                                                                     |
| `008` | Typed Linq chat extension                          | Contact, presence, and voice  | Share the configured Name and Photo card, mark read, stop typing, and send native voice memos through a minimal conversation API.                                                                                                                              |
| `009` | Typed Linq chat extension                          | Groups and location           | Add cohesive group management and location APIs, lifecycle events, constraints, and disposable sandbox tests.                                                                                                                                                  |
| `010` | Standard mapping + typed chat extension            | Protocol, formatting, effects | Map standard text styles and add cohesive protocol, animation, and effect options with exact fallback/error behavior.                                                                                                                                          |
| `011` | Typed Linq chat extension                          | iMessage app messages         | Add typed app-message send/update behavior and extension-required documentation; Experiences remain on `adapter.client`.                                                                                                                                       |
| `012` | Internal adapter behavior + standard mapping       | Media lifecycle               | Complete automatic upload/readiness/format/refresh/retention/error coverage; attachment administration remains on `adapter.client`.                                                                                                                            |
| `013` | Standard mapping + internal + typed chat extension | Chat-parity cleanup           | Resolve remaining adapter-owned rows and mechanically verify the 57-operation/35-event inventory; native-client, recipes, and out-of-scope rows remain.                                                                                                        |

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
