# Linq feature parity

This document is the authoritative capability inventory and implementation backlog for the Linq
Chat SDK adapter. **Feature parity means complete, non-lossy coverage of Linq's chat and messaging
capabilities**, not a second wrapper around the entire Linq SDK.

The inventory is the authoritative status matrix for adapter-owned capabilities and records the
native-client and out-of-scope boundary. Consolidated Batch `000` refreshed the full mechanical
inventory; completed Batch `005` uses the current event enum and preserves unknown future events
losslessly.

Sources of truth:

- [Linq documentation index](https://docs.linqapp.com/llms.txt)
- [Linq Partner API V3 OpenAPI document](https://cdn.linqapp.com/openapi/linq-api-v3.yaml)
- [`chat` adapter contract](https://chat-sdk.dev/docs/contributing/building)

Evidence reverified **2026-08-21**: the canonical OpenAPI has **68 callable operations**, **56
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
- Keep capability status separate from external evidence. Absence of a provider, device, or host
  observation does not by itself make an otherwise complete adapter-owned capability `Partial`.

Evidence labels used throughout this matrix:

- **Documented:** current Linq documentation or canonical OpenAPI describes the behavior.
- **Contract-verified:** deterministic unit, type, fixture, and applicable Chat SDK integration
  contracts pass.
- **Provider-observed:** a real Linq API response or provider-produced signed delivery was observed.
- **Device-observed:** named iMessage, RCS, or SMS behavior was observed on a physical device.
- **Host-staged:** a real consumer staging route validated the deployment seam it relies on.

External evidence is event-triggered and claim-specific, not a universal completion gate. Preserve
the date/version and exact assertion for observations; never let one label imply another.

Package-artifact and package-consumer validation belong to Linq's upstream review and release
process. They are not local adapter roadmap or completion gates.

Provider-produced webhook compatibility is revisited when the signing verifier,
`standardwebhooks` dependency, supported webhook version, Linq signing contract, or host raw-body
handling materially changes. Its narrow assertion is that Linq's real Standard Webhooks headers,
server-generated signature over the untouched body, versioned envelope, and the adapter's `2xx`
response remain compatible. It does not establish deduplication, callback timing, `waitUntil`,
database behavior, or Linq delivery reliability. Legacy remains locally contract-tested unless a
real legacy subscription is being migrated.

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
- Public documentation uses the standard API and labels any provider/device observations without
  making them part of adapter completion.
- Existing factory and standard adapter behavior remain compatible or include a migration plan.

### Internal adapter behavior

- No separate public method or exported endpoint-shaped input/result type is added.
- The behavior is exercised through the standard Chat SDK operation it supports, including
  validation, provider errors, retries, resource cleanup, and malformed input.
- Unit/contract coverage proves the internal path; focused external observations are recorded only
  when they materially clarify a provider, device, or host boundary.

### Typed Linq chat extension

- Chat SDK cannot faithfully express the native conversation/message semantics, and the matrix
  records why.
- The smallest cohesive typed method, option, or event API preserves Linq constraints and results
  without mirroring an endpoint one-for-one.
- Stable errors, documentation with an example, and unit/contract coverage are complete. Applicable
  provider/device/host observations are labeled separately.

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

| Area                         | Primary disposition(s)                       | Current state | Next completion target                                           |
| ---------------------------- | -------------------------------------------- | ------------- | ---------------------------------------------------------------- |
| Existing-chat text/media     | Standard mapping + internal behavior         | Complete      | Maintain supported send/download contracts; `012A` is optional   |
| Proactive send/chat creation | Native client + recipe                       | Complete      | Optional `004B` provider evidence; no `openDM()`                 |
| Webhooks                     | Standard + internal + typed chat extension   | Complete      | Maintain verifier, schema, and event-inventory drift checks      |
| Contact sharing/read/voice   | Standard mapping + typed Linq extension      | Complete      | Maintain current contracts; optional `012A` adds one source form |
| Groups and location          | Typed Linq chat extension                    | Complete      | Optional provider/device evidence only                           |
| Rich messaging               | Standard mapping + typed Linq chat extension | Partial       | iMessage app messages remain deferred in Batch `011`             |
| Native client boundary       | Native Linq client                           | Complete      | Routine official-client compatibility maintenance                |

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
`adapter.client.chats.create()` when the application must choose the sending line explicitly, then
construct the canonical Thread from `result.chat.id`. Generate a new key for each distinct
intentional send; reuse a key only to retry the same logical operation.

The installed contracts verify both native request/response shapes and the post-success canonical
handoff. Linq's documented creation/reuse, auto-line selection/failover, same-key deduplication,
concurrency, delivery, and service/device presentation remain provider-owned and unverified here.
Chat SDK Thread IDs are readonly; a recipient-derived provisional Thread cannot adopt the returned
chat ID and can split later sends, subscriptions, and state. No provisional identity or `openDM()`
path is supported.

Batch `004A` is complete with `Documented` and `Contract-verified` recipe/compile-time evidence.
Batch `004` adds no runtime
adapter method, provisional thread ID, alias, identity migration, persistence scheme, first-send
lock, retry loop, or Chat SDK dependency change. Selective sandbox observation of creation, reuse,
same-key retry, failover, or concurrent sends is supplementary `Provider-observed` evidence, not
adapter completion; optional `004B` remains incomplete. A first-class proactive extension remains
deferred until demonstrated usage justifies it.

## Endpoint parity

The `Disposition` column is normative. The `Adapter API` column names the supported public surface,
not every internal SDK call. `Missing` on a native-client row means `adapter.client` is still private
or the resolved official client lacks that operation.

### Attachments

| Linq operation                                                     | Disposition               | Adapter API                           | Status     | Limitations / completion gap                                                                                                                                                                                                                                                                                                                    | Priority | Test coverage                                                                        |
| ------------------------------------------------------------------ | ------------------------- | ------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `POST /v3/attachments` — pre-upload a file                         | Internal adapter behavior | `thread.post({ files })`              | Complete   | Buffered caller-supplied bytes use no-retry creation, validated name/size, HTTPS non-redirecting upload URLs, preparation-only cleanup, and shared errors. The adapter never fetches arbitrary outbound source URLs. Deprecated attachment `status` is not polled; large-file streaming and workflow retries/cleanup require demonstrated need. | P0       | Contract-verified upload/URL security/cleanup/errors; Provider-observed smoke `send` |
| `GET /v3/attachments/{attachmentId}` — retrieve metadata/fresh URL | Internal adapter behavior | Attachment `fetchData()`/rehydration  | Complete   | Stable attachment identity resolves fresh metadata/download URLs for persistent and ephemeral media. Retention/deletion policy is caller-owned through `adapter.client`; no automatic deletion is added.                                                                                                                                        | P0       | Contract-verified inbound/rehydration; no external observation                       |
| `DELETE /v3/attachments/{attachmentId}` — delete attachment        | Native Linq client        | `adapter.client.attachments.delete()` | Client API | Attachment administration is not standard message/file behavior; official client semantics apply.                                                                                                                                                                                                                                               | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq                   |

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

| Linq operation                                                | Disposition               | Adapter API                                                  | Status     | Limitations / completion gap                                                                                                                                                                                                                                                                                             | Priority | Test coverage                                                                      |
| ------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------- |
| `POST /v3/chats` — create chat with initial message           | Native Linq client        | `adapter.client.chats.create()`                              | Client API | Explicit fixed-line creation remains native-client behavior. The documented recipe uses nested message idempotency and constructs a canonical Thread only from returned `chat.id`. Linq owns creation/reuse behavior; do not add `adapter.createChat()` or route it through `openDM()`.                                  | —        | Documented + Contract-verified recipe/client handoff; Device-observed send         |
| `GET /v3/chats` — list chats                                  | Native Linq client        | `adapter.client.chats.listChats()`                           | Client API | Chat SDK has no faithful chat-list contract; do not add `adapter.listChats()`.                                                                                                                                                                                                                                           | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq                 |
| `GET /v3/chats/{chatId}` — retrieve chat                      | Internal adapter behavior | Standard thread construction/refresh                         | Complete   | Returns canonical thread identity and lossless chat metadata; provider failures use the shared adapter error taxonomy without retries or fallback.                                                                                                                                                                       | P0       | Contract-verified thread/identity, exact call, validation, and errors              |
| `PUT /v3/chats/{chatId}` — update group name/icon             | Typed Linq chat extension | `adapter.conversation(threadOrId).group.update()`            | Complete   | Maps only display name/public HTTPS icon and rejects empty/unknown input pre-I/O. `202` is queued acceptance; typed outcome events remain separate and are not request-correlated without a provider key.                                                                                                                | P1       | Contract-verified fields, validation, known-DM guard, exact calls/errors           |
| `POST /v3/chats/{chatId}/leave` — leave group                 | Typed Linq chat extension | `adapter.conversation(threadOrId).group.leave()`             | Complete   | Calls the canonical acknowledgement-only operation. Linq supports iMessage groups with 4+ active members; after processing, the chat becomes inaccessible. No local member probe, retry, idempotency, or correlated completion is added.                                                                                 | P2       | Contract-verified exact/repeated calls, known-DM guard, errors, Chat coexistence   |
| `GET /v3/chats/{chatId}/location` — get shared locations      | Typed Linq chat extension | `adapter.conversation(threadOrId).location.retrieve()`       | Complete   | Returns an immutable ordered snapshot of independently validated GeoJSON Point rows. Coordinates are longitude-first; valid altitude/address/locality/provider timestamps are optional. Retrieval is on demand and separate from request/consent; no polling service, cache, geocoding, or identity resolution is added. | P1       | Contract-verified exact call, mixed/empty/malformed rows, order, dates, errors     |
| `POST /v3/chats/{chatId}/location/request`                    | Typed Linq chat extension | `adapter.conversation(threadOrId).location.request()`        | Complete   | Acknowledgement means only that Linq accepted the prompt request, not consent, coordinates, duration, or delivery. Known groups reject locally; opaque chat service compatibility remains provider-enforced without a probe.                                                                                             | P1       | Contract-verified exact/repeated call, known-group guard, shared errors            |
| `POST /v3/chats/{chatId}/messages` — send to existing chat    | Standard Chat SDK mapping | `thread.post()` / `thread.reply()`                           | Complete   | Supported text/media/cards, rich links, replies, part targeting, decorations, service, and effects have central validation and Chat contracts. Optional voice-memo `FileUpload` support is a separate extension concern.                                                                                                 | P0       | Contract-verified send/reply/options/parts; Provider-observed send/cards           |
| `GET /v3/chats/{chatId}/messages` — list chat messages        | Standard Chat SDK mapping | `thread.messages`; `thread.allMessages` unsupported          | Partial    | Backward history preserves usable endpoint rows/cursors. Bad rows and null/malformed/unknown parts are isolated, provider failures use shared errors, and forward pagination remains unsupported.                                                                                                                        | P0       | Contract-verified hostile pages/parts, cursor/order, errors, Chat iteration        |
| `POST /v3/chats/{chatId}/participants` — add participant      | Typed Linq chat extension | `adapter.conversation(threadOrId).group.addParticipant()`    | Complete   | Validates one E.164/email handle and calls the canonical queued operation. Linq enforces iMessage group/service compatibility and membership limits; the adapter adds no capability/classification probe or request-event correlation.                                                                                   | P1       | Contract-verified handles, exact/repeated calls, known-DM guard, errors            |
| `DELETE /v3/chats/{chatId}/participants` — remove participant | Typed Linq chat extension | `adapter.conversation(threadOrId).group.removeParticipant()` | Complete   | Validates one E.164/email handle and calls the canonical queued operation. Linq enforces iMessage groups and 3+ remaining members; leaving self stays the dedicated method. No snapshot, retry, or correlated completion is inferred.                                                                                    | P1       | Contract-verified handles, exact/repeated calls, known-DM guard, errors            |
| `POST /v3/chats/{chatId}/read` — mark read                    | Standard Chat SDK mapping | `thread.markAsRead(messageOrId)`                             | Partial    | Implemented through the standard Chat API; Linq marks the entire chat and ignores message granularity. Exact-line invocation succeeded, but the sending device exposed delivery rather than a read receipt; repeated/error handling remains.                                                                             | P1       | Contract-verified; Provider-observed acceptance; Device-observed no receipt        |
| `POST /v3/chats/{chatId}/share_contact_card`                  | Typed Linq chat extension | `adapter.conversation(threadOrId).shareContactCard()`        | Complete   | Calls the official no-body operation for a canonical chat. Linq requires an active configured card and prior outbound activity; it is iMessage-only, repeated calls within 24h do not re-present, and no recipient-save guarantee is inferred.                                                                           | P1       | Contract-verified exact/repeated calls, ownership, errors, Chat coexistence        |
| `POST /v3/chats/{chatId}/typing` — start typing               | Standard Chat SDK mapping | `thread.startTyping()`                                       | Complete   | Direct and group threads call the canonical acknowledgement-only operation with shared error translation. Hosts own refresh cadence; acceptance does not prove recipient presentation or delivery.                                                                                                                       | P1       | Contract-verified direct/group calls, ownership, errors, Chat integration          |
| `DELETE /v3/chats/{chatId}/typing` — stop typing              | Typed Linq chat extension | `adapter.conversation(threadOrId).stopTyping()`              | Complete   | Calls the official no-body operation for a canonical direct or group chat. Success is acceptance only; sending a message or the provider timeout also clears typing. No flat alias, delivery guarantee, or adapter retry is added.                                                                                       | P2       | Contract-verified exact/repeated calls, group path, errors, Chat coexistence       |
| `POST /v3/chats/{chatId}/voicememo`                           | Typed Linq chat extension | `adapter.conversation(threadOrId).sendVoiceMemo()`           | Complete   | Accepts exactly one public HTTPS URL or existing attachment UUID and returns only accepted canonical identities. Remote size/format/reachability/ownership remain provider validations; a raw Chat SDK `FileUpload` source is optional Batch `012A`.                                                                     | P1       | Contract-verified exact calls, validation, identity, errors, lifecycle coexistence |
| `POST /v3/chats/{chatId}/background`                          | Native Linq client        | `adapter.client.chats.background.set()`                      | Client API | Endpoint-shaped asynchronous background administration; success/failure may be observed generically.                                                                                                                                                                                                                     | —        | Endpoint behavior owned by Linq                                                    |
| `DELETE /v3/chats/{chatId}/background`                        | Native Linq client        | `adapter.client.chats.background.remove()`                   | Client API | Reset behavior remains native-client-only.                                                                                                                                                                                                                                                                               | —        | Endpoint behavior owned by Linq                                                    |
| `POST /v3/chats/{chatId}/polls`                               | Native Linq client        | `adapter.client.chats.polls.create()`                        | Client API | Poll workflow is out of adapter scope; official client owns iMessage constraints.                                                                                                                                                                                                                                        | —        | Endpoint behavior owned by Linq                                                    |

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

| Linq operation                                           | Disposition               | Adapter API                                    | Status     | Limitations / completion gap                                                                                                                                                                                                     | Priority | Test coverage                                                                                             |
| -------------------------------------------------------- | ------------------------- | ---------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `GET /v3/experiences` — list invokable experiences       | Native Linq client        | `adapter.client.experiences.list()`            | Client API | Available in `@linqapp/sdk@0.42.0`; no bespoke adapter discovery API.                                                                                                                                                            | —        | Endpoint behavior owned by Linq                                                                           |
| `GET /v3/experiences/{experience}`                       | Native Linq client        | `adapter.client.experiences.retrieve()`        | Client API | Available in `@linqapp/sdk@0.42.0`; invocation remains native client behavior.                                                                                                                                                   | —        | Endpoint behavior owned by Linq                                                                           |
| `POST /v3/messages` — auto-selected sender               | Native Linq client        | `adapter.client.messages.create()`             | Client API | Completed proactive recipe: one nested message idempotency key per logical send, then construct a canonical Chat SDK thread from returned `chat_id`. Creation/reuse/deduplication/failover/concurrency remain provider behavior. | —        | Documented + Contract-verified handoff; optional provider observation                                     |
| `GET /v3/messages/{messageId}`                           | Internal adapter behavior | Standard message/history/refresh behavior      | Complete   | Edit IDs refresh; `404` returns no message while other provider failures use shared errors. Retrieved provider facts stay lossless in `Message.raw`; `updated_at` is not edit proof.                                             | P0       | Contract-verified refresh, tombstone, hostile parts, typed/raw fidelity, errors                           |
| `PATCH /v3/messages/{messageId}` — edit text part        | Standard Chat SDK mapping | `SentMessage.edit()`                           | Partial    | Deterministic non-empty text replaces part 0 and provider failures use shared errors. Linq-enforced edit windows/counts and arbitrary-part edits remain outside the current standard mapping.                                    | P1       | Contract-verified part-0 compilation, validation, identity, and errors                                    |
| `DELETE /v3/messages/{messageId}` — delete Linq record   | Native Linq client        | `adapter.client.messages.delete()`             | Client API | Storage deletion is not recipient unsend and must never back Chat SDK `SentMessage.delete()`.                                                                                                                                    | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq                                        |
| `POST /v3/messages/{messageId}/reactions`                | Standard Chat SDK mapping | `SentMessage.addReaction()`/`removeReaction()` | Partial    | Whole-message and part-specific standard/custom add/remove operations validate locally knowable input and use shared errors. Outbound sticker input remains deferred.                                                            | P0       | Contract-verified placement, validation, errors, and Chat coexistence; Provider-observed inbound reaction |
| `GET /v3/messages/{messageId}/thread`                    | Native Linq client        | `adapter.client.messages.listMessagesThread()` | Client API | Linq reply threads do not match Chat SDK conversation threads; avoid an endpoint-shaped wrapper.                                                                                                                                 | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq                                        |
| `POST /v3/messages/{messageId}/update` — update app card | Typed Linq chat extension | Cohesive typed iMessage app-message API        | Missing    | Delivered outbound card only; serialize updates, inherit app identity, preserve new message IDs, and enforce iMessage-only behavior.                                                                                             | P2       | None                                                                                                      |
| `GET /v3/messages/{messageId}/poll`                      | Native Linq client        | `adapter.client.messages.poll.retrieve()`      | Client API | Poll workflow remains outside adapter semantics.                                                                                                                                                                                 | —        | Endpoint behavior owned by Linq                                                                           |
| `POST /v3/messages/{messageId}/poll/options`             | Native Linq client        | `adapter.client.messages.poll.addOptions()`    | Client API | Add-only poll options remain native-client behavior.                                                                                                                                                                             | —        | Endpoint behavior owned by Linq                                                                           |
| `POST /v3/messages/{messageId}/poll/votes`               | Native Linq client        | `adapter.client.messages.poll.vote()`          | Client API | Vote workflow remains native-client-only.                                                                                                                                                                                        | —        | Endpoint behavior owned by Linq                                                                           |

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

| Message capability                         | Disposition                        | Adapter API                                                   | Status     | Constraints / limitations                                                                                                                                                                                                                                                                        | Priority | Test coverage                                                                     |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------- |
| Linq message-options transport             | Typed Linq chat extension          | `linqMessage(content, options)`                               | Complete   | Immutable metadata survives Chat processing. Decorations, service, effects, and standalone rich links compile on post/reply; metadata stays out of `SentMessage`/history.                                                                                                                        | P0       | Contract-verified transport, identity, serialization, options                     |
| Plain text parts                           | Standard Chat SDK mapping          | `thread.post(text)`                                           | Partial    | Existing-chat sends enforce non-empty/10,000-character limits, idempotency, SDK retry ownership, and shared provider errors. Initial proactive sends use the completed Batch `004A` native-client recipe; no adapter `openDM()` path is planned.                                                 | P0       | Contract-verified; Provider-observed `send`                                       |
| Chat SDK markdown/AST                      | Standard Chat SDK mapping          | `thread.post({ markdown/ast })`                               | Partial    | Deterministic text preserves links/newlines and maps bold/italic/strike. Unsupported Markdown remains plain text; no native-Markdown claim.                                                                                                                                                      | P1       | Contract-verified raw/Markdown/AST/card rendering                                 |
| Inline text styles                         | Standard mapping + typed extension | Standard formatted content + `LinqMessageOptions.decorations` | Complete   | Derived bold/italic/strike and manual styles use validated UTF-16 ranges. Exact duplicates collapse; nested, adjacent, and partially overlapping styles remain deterministic.                                                                                                                    | P1       | Contract-verified ranges, Unicode, nesting, combinations, pre-I/O failure         |
| Inline text animations                     | Typed Linq chat extension          | `LinqMessageOptions.decorations`                              | Complete   | The eight typed animations use validated UTF-16 ranges. Exact duplicates collapse; animations may be adjacent but cannot overlap any decoration. No recipient-presentation claim.                                                                                                                | P2       | Contract-verified closed unions, ranges, overlaps, post/reply                     |
| Media by public HTTPS URL                  | Standard Chat SDK mapping          | `thread.post({ attachments })`                                | Complete   | Existing sends validate HTTPS and the 40-part sub-limit while preserving by-reference delivery; inbound downloads use the same bounded fresh-URL path.                                                                                                                                           | P0       | Contract-verified boundaries/download; Provider-observed `send`                   |
| Media by pre-uploaded attachment/raw bytes | Standard Chat SDK mapping          | `thread.post({ files })`                                      | Complete   | Existing sends enforce 1–255-character names and 1-byte–100MB caller-supplied buffered uploads with preparation-only cleanup. URL-only over-limit/non-HTTPS sources reject before local network or Linq I/O; provider upload redirects reject. Large-file streaming waits for demonstrated need. | P0       | Contract-verified boundaries/URL security/cleanup; Provider-observed `send`       |
| Inbound media and fresh downloads          | Standard Chat SDK mapping          | `message.attachments` / `fetchData()`                         | Complete   | Images, files, and audio—including user voice memos—retain stable attachment identity and resolve fresh bounded downloads. Canonical media parts do not distinguish native voice memos from ordinary audio; no discriminator or URL/filename heuristic is exposed.                               | P0       | Contract-verified parsing, stable IDs, rehydration, and downloads                 |
| Rich link part                             | Typed Linq chat extension          | `linqMessage(content, { richLink })`                          | Complete   | Standalone HTTPS URL ≤2,048 characters; rejects text/card/file/attachment coexistence pre-I/O. Preserves service intent and documents SMS bare-URL fallback without presentation claims.                                                                                                         | P1       | Contract-verified boundaries, exclusivity, service matrix, post/reply             |
| Mixed and multipart messages               | Standard Chat SDK mapping          | `thread.post()`                                               | Partial    | Text followed by media enforces 100 total parts and 40 public URLs, including card images; richer alternating/native part inputs remain later work.                                                                                                                                              | P1       | Contract-verified boundaries; Provider-observed text/media                        |
| Ordinary replies (`reply_to`)              | Standard Chat SDK mapping          | `thread.reply(messageOrId, content)`                          | Partial    | Implemented with canonical identity, explicit idempotency, and official SDK request placement. Exact-line iMessage reply threading passed; provider error handling remains incomplete.                                                                                                           | P1       | Contract-verified; Device-observed exact-line reply                               |
| Part-index reply targeting                 | Typed Linq chat extension          | `adapter.conversation(threadOrId).replyToPart(...)`           | Complete   | The facade validates canonical UUIDs and non-negative indexes, then preserves callback processing, returned identity, edits, and history. No presentation claim.                                                                                                                                 | P1       | Contract-verified zero/nonzero placement, validation, identity, Chat coexistence  |
| Screen effects                             | Typed Linq chat extension          | `LinqMessageOptions.effect`                                   | Complete   | Eleven typed screen names map at message level. Omitted service is best-effort; explicit iMessage is strict; explicit RCS/SMS with an effect rejects before side effects. No presentation claim.                                                                                                 | P2       | Contract-verified closed values, placement, policy, media/reply                   |
| Bubble effects                             | Typed Linq chat extension          | `LinqMessageOptions.effect`                                   | Complete   | Four typed bubble names map at message level and follow the same service policy. One effect is represented per immutable options snapshot. No presentation claim.                                                                                                                                | P2       | Contract-verified closed values, placement, policy                                |
| Preferred service                          | Typed Linq chat extension          | `LinqMessageOptions.preferredService`                         | Complete   | Omission preserves normal selection; explicit iMessage/RCS/SMS maps exactly. RCS/SMS with effects or manual decorations rejects before side effects; derived formatting may degrade. No strictness option.                                                                                       | P1       | Contract-verified full matrix, post/reply/media, pre-I/O rejection                |
| Idempotency                                | Internal adapter behavior          | Standard existing-chat sends; native proactive recipe         | Partial    | Existing-chat `postMessage()` generates one UUID per logical call and the official SDK reuses it for retries. Proactive callers provide one key per logical native send and reuse it only for that operation; provider dedupe/concurrency remain provider-owned.                                 | P0       | Contract-verified existing path + proactive recipe; provider evidence optional    |
| Auto-selected sender/failover              | Native Linq client                 | `adapter.client.messages.create()`                            | Client API | Native response retains chosen line, reuse/new-chat result, previous chat, and failover reason. Batch `004` documents the canonical handoff without adding an adapter wrapper.                                                                                                                   | —        | Contract-verified public-client boundary; provider observation optional           |
| Fixed-line chat creation                   | Native Linq client                 | `adapter.client.chats.create()`                               | Client API | Exact participant-set reuse, named-group semantics, and first-send restrictions stay on the official client. Guarded smoke tooling fails closed unless the returned owner and direct recipient match.                                                                                            | —        | Contract-verified smoke contract; Device-observed exact-line send                 |
| Native Name and Photo contact sharing      | Typed Linq chat extension          | `adapter.conversation(threadOrId).shareContactCard()`         | Complete   | Sends the configured sending-number card through the official acknowledgement-only operation. Configuration/cadence remain caller-owned; iMessage presentation and recipient saving are not guaranteed.                                                                                          | P1       | Contract-verified exact/repeated calls, constraints, errors, Chat coexistence     |
| Native voice-memo request                  | Typed Linq chat extension          | `adapter.conversation(threadOrId).sendVoiceMemo()`            | Complete   | Public HTTPS URL/existing attachment-ID inputs map to the canonical endpoint and return accepted identities. A raw Chat SDK `FileUpload` source is optional Batch `012A`; native/fallback presentation remains optional device evidence.                                                         | P1       | Contract-verified calls, validation, identity, errors, lifecycle coexistence      |
| Standard tapbacks                          | Standard Chat SDK mapping          | Standard reaction APIs/handlers                               | Partial    | Six tapbacks map both directions; whole-message add/remove now share deterministic validation and provider-error translation. Exact-line removal remains optional device evidence.                                                                                                               | P0       | Contract-verified add/remove/errors; Device-observed exact-line add/inbound       |
| Custom emoji reactions                     | Standard Chat SDK mapping          | Standard reaction APIs/handlers                               | Partial    | Standard custom emoji add/remove uses the same shared error contract; recipient rendering and asynchronous delivery remain provider/device observations.                                                                                                                                         | P1       | Contract-verified mapping, validation, and errors                                 |
| Sticker reactions                          | Typed Linq chat extension          | Verified message observation + `Message.raw`                  | Partial    | Inbound sticker metadata and per-part placement are typed/lossless; standard dispatch skips stickers. Outbound remains deferred pending unambiguous SDK input.                                                                                                                                   | P2       | Contract-verified typed/raw inbound observation and standard-dispatch skip        |
| Part-specific reactions                    | Typed Linq chat extension          | `adapter.conversation(threadOrId)` reaction options           | Complete   | Add/remove preserves omitted, explicit `0`, and nonzero indexes after pre-I/O validation. Whole-message reactions remain standard Chat SDK behavior.                                                                                                                                             | P2       | Contract-verified add/remove coexistence, placement, validation, errors           |
| Edit text part                             | Standard Chat SDK mapping          | `SentMessage.edit()`                                          | Partial    | Standard part-0 edit uses deterministic non-empty plain text and shared provider errors. SDK `0.42.0` cannot replace decorations; Linq-enforced windows/counts and arbitrary parts remain outside the mapping.                                                                                   | P1       | Contract-verified compilation, validation, identity, errors, and Chat integration |
| Delete Linq record                         | Native Linq client                 | `adapter.client.messages.delete()`                            | Client API | Storage deletion only, never recipient unsend.                                                                                                                                                                                                                                                   | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq                |
| Delivery/read/reconciliation state         | Typed Linq chat extension          | Generic typed `onLinqEvent` + metadata                        | Complete   | Sent/delivered/read/failed/edit facts and recovered-history markers are typed. Reconciled inbound observations bypass new-message dispatch; no ordering, terminal-state, retry, conflict, or workflow guarantee is inferred.                                                                     | P0       | Contract-verified fixtures, malformed/unknown/tombstone data, dedupe, Chat route  |
| Apple Pay App Clip payment card            | Native Linq client                 | `adapter.client.chats.create()` / chat-message native methods | Client API | SDK `0.42.0` adds a standalone Linq checkout-link part that is iMessage-only and never downgrades. Inbound cards preserve the checkout URL as standard text/link plus the complete raw part; no payment-specific adapter API is planned.                                                         | —        | Unit inbound normalization; endpoint behavior owned by Linq                       |
| iMessage app part                          | Typed Linq chat extension          | Cohesive typed iMessage app-message API                       | Missing    | Must stand alone, requires a real Messages extension, and needs static fallback/layout validation.                                                                                                                                                                                               | P2       | None                                                                              |
| Update iMessage app card                   | Typed Linq chat extension          | Cohesive typed iMessage app-message API                       | Missing    | Delivered outbound card only; serialize updates and preserve new message identity.                                                                                                                                                                                                               | P2       | None                                                                              |
| Experience action                          | Native Linq client                 | `adapter.client.messages.create({ action })`                  | Client API | Experience discovery/action invocation is not a direct adapter priority.                                                                                                                                                                                                                         | —        | Unit + type: `public-api.test.ts`; endpoint behavior owned by Linq                |
| Chat SDK cards                             | Standard Chat SDK mapping          | `thread.post(<Card />)`                                       | Partial    | Static text/images and supported `CardText` formatting work; interactive controls remain labels unless a true iMessage app bridge exists.                                                                                                                                                        | P1       | Contract-verified fallback/decorations; Provider-observed `cards`                 |
| Streaming                                  | Standard Chat SDK mapping          | `thread.post(asyncIterable)`                                  | Complete   | Linq has no native stream; strings and Markdown chunks buffer once and pass through the same final text/options compiler. Non-message progress chunks are not sent.                                                                                                                              | P2       | Contract-verified compiled final send; no native/timing claim                     |
| Message/history pagination direction       | Standard Chat SDK mapping          | `thread.messages`; `thread.allMessages` unsupported           | Partial    | Backward pages preserve endpoint order/cursor; Chat SDK reverses each page. Bad rows/parts are isolated. Forward is rejected; no provider ordering guarantee is inferred.                                                                                                                        | P0       | Contract-verified page/order/cursor/hostile input and Chat iteration              |
| Ephemeral attachment refresh/retention     | Internal behavior + native client  | Standard `fetchData()`; `adapter.client` administration       | Complete   | Stable IDs resolve fresh URLs for downloads. Linq retention tiers and deletion policy are application-owned; the adapter does not infer expiry or delete attachments automatically.                                                                                                              | P2       | Contract-verified stable-ID refresh and bounded download                          |
| Message limits and validation              | Internal adapter behavior          | All standard/extension send paths                             | Partial    | Existing-chat inputs enforce content/media/decorations plus contradictory explicit service intent before side effects; richer native-part rules remain selective.                                                                                                                                | P0       | Focused boundary and no-side-effect unit tests                                    |

## Webhook parity

Target API for events without a Chat SDK equivalent:

```ts
const unsubscribe = adapter.onLinqEvent("message.delivered", async (event) => {
  console.log(event.data.providerMessageId, event.data.deliveredAt, event.envelope.traceId);
});
```

Slices `005A`–`005C` implement this one/many/all registration surface, its adapter-instance
registry, the checked-in OpenAPI-derived 45-name type inventory, verified fan-out, standard
message/reaction coexistence, atomic provider/partner/event deduplication, and non-blocking
`waitUntil` scheduling. A claimed callback is at-most-once attempted: handler failure is isolated
and logged, not made eligible for provider retry. All-event handlers retain a lossless future-event
form rather than treating the current 45 names as an exhaustive provider universe. Historical real
Standard delivery remains `Provider-observed`; current dedupe, timing, and `waitUntil` behavior is
`Contract-verified` and is not inferred from that provider observation.

Slice `006A` adds curated current-version `data` contracts for `message.sent`,
`message.delivered`, `message.read`, and `message.failed`. Lifecycle callbacks preserve stable
message/chat correlation, services, idempotency key, and stage timestamps. Failure callbacks
preserve numeric code, opaque detail code, reason, service facts, and failure time; trace remains in
the envelope and the full authenticated payload remains in `rawEvent`. The adapter intentionally
does not derive retryability or a terminal/ordered workflow state: Linq's guidance is code-specific,
SMS/MMS omit delivered/read receipts, and a delivered event may rarely follow a failed event.

Slice `006B` adds a compact typed `message.edited` contract with message/chat correlation, sender,
zero-based part index, replacement text, and edit time. It also treats `reconciled_at` as a
recovered-history marker: the verified generic callback remains available, but a reconciled inbound
message does not enter Chat SDK's new-message handlers. Consumers may refresh by provider message
ID for the current snapshot; a deleted message can refresh to `null`, and Linq's retrieval schema
does not expose enough evidence to infer an edit from `updated_at`. Webhook and history snapshots
may therefore arrive in either order. The adapter does not merge them or resolve conflicts.

`onLinqEvent()` must provide an overload for a single type, multiple types, and all events; return an
unsubscribe function; preserve the verified raw envelope; deduplicate on the provider event ID; and
never delay the webhook acknowledgement unnecessarily. Standard Chat SDK dispatch should still run
for message and reaction events where applicable.

All verified Linq events are eligible for lossless generic typed passthrough so consumers do not
lose subscribed events. Only standard message/reaction dispatch and true chat-native extensions
receive adapter-owned semantics. Payment Request events are consumed by a recipe; payment,
Agentcard, call, phone-administration, and other business workflows are not implemented here.

The current OpenAPI enum has 45 names. The adapter owns the event inventory because
`@linqapp/sdk@0.42.0` no longer exports an unwrap union. The completed Batch `005` uses an
adapter-owned event map plus a lossless future-event form; poll rows authorize generic delivery
only, not a workflow. Every known event has a typed discriminant and immutable lossless raw data,
but only the rows marked with curated data below expose a normalized provider-specific model.

| Webhook event                   | Disposition               | Adapter API / behavior                            | Status       | Limitations / completion gap                                                                                                                                                                                        | Priority | Test coverage                                                                   |
| ------------------------------- | ------------------------- | ------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `message.sent`                  | Typed Linq chat extension | Generic typed `onLinqEvent` + lifecycle data      | Complete     | Curated correlation/service/idempotency/timestamps; no standard message event, ordering, or delivery guarantee is invented.                                                                                         | P0       | Contract-verified fixture, malformed data, dedupe, public types                 |
| `message.received`              | Standard Chat SDK mapping | Standard message handlers + `onLinqEvent`         | Complete     | Current inbound messages dispatch normally; typed/raw fidelity covers reply, effect, service, decorations, reactions, reconciliation, and stickers. Bad parts are isolated; recovered history remains generic-only. | P0       | Contract-verified hostile fidelity/reconciliation; Provider-observed `serve`    |
| `message.read`                  | Typed Linq chat extension | Generic typed `onLinqEvent` + lifecycle data      | Complete     | Curated timestamp/correlation contract; SMS/MMS do not emit this receipt and event order is not guaranteed by the adapter.                                                                                          | P0       | Contract-verified fixture, malformed data, dedupe, public types                 |
| `message.delivered`             | Typed Linq chat extension | Generic typed `onLinqEvent` + lifecycle data      | Complete     | Curated timestamp/correlation contract; SMS/MMS do not emit this receipt and it may rarely follow a failed observation.                                                                                             | P0       | Contract-verified fixture, malformed data, dedupe, public types                 |
| `message.failed`                | Typed Linq chat extension | Generic typed `onLinqEvent` + failure data        | Complete     | Numeric/opaque provider diagnostics and nullable correlation are preserved; retryability and terminal state are not derived.                                                                                        | P0       | Contract-verified fixture, unknown codes/fields, malformed data                 |
| `message.edited`                | Typed Linq chat extension | Generic typed `onLinqEvent` + refresh correlation | Complete     | Confirms one edited text part and its time. Full current state requires a separate refresh; no automatic mutation or conflict resolution.                                                                           | P1       | Contract-verified fixture, malformed/unknown/tombstone, dedupe, public types    |
| `reaction.added`                | Standard Chat SDK mapping | Standard `onReaction()` + `onLinqEvent`           | Complete     | Standard/custom reactions dispatch normally; typed/raw observations preserve part indexes and stickers. Stickers intentionally skip standard emoji dispatch.                                                        | P0       | Contract-verified part/sticker fidelity; Provider-observed inbound              |
| `reaction.removed`              | Standard Chat SDK mapping | Standard `onReaction()` + `onLinqEvent`           | Complete     | Standard/custom reactions dispatch normally with the same typed/raw part/sticker preservation. Stickers intentionally skip standard emoji dispatch.                                                                 | P0       | Contract-verified part/sticker fidelity; Provider-observed inbound              |
| `poll.received`                 | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                                                                                                              | —        | N/A beyond generic passthrough                                                  |
| `poll.failed`                   | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                                                                                                              | —        | N/A beyond generic passthrough                                                  |
| `poll.sent`                     | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                                                                                                              | —        | N/A beyond generic passthrough                                                  |
| `poll.delivered`                | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                                                                                                              | —        | N/A beyond generic passthrough                                                  |
| `poll.read`                     | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                                                                                                              | —        | N/A beyond generic passthrough                                                  |
| `poll.updated`                  | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                                                                                                              | —        | N/A beyond generic passthrough                                                  |
| `poll.vote.added`               | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                                                                                                              | —        | N/A beyond generic passthrough                                                  |
| `poll.vote.removed`             | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                                                                                                              | —        | N/A beyond generic passthrough                                                  |
| `poll.reaction.added`           | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Preserve the verified envelope generically; do not add adapter poll workflow behavior.                                                                                                                              | —        | N/A beyond generic passthrough                                                  |
| `participant.added`             | Typed Linq chat extension | Generic typed `onLinqEvent`                       | Missing      | Preserve participant identity and refresh group metadata when needed.                                                                                                                                               | P1       | None                                                                            |
| `participant.removed`           | Typed Linq chat extension | Generic typed `onLinqEvent`                       | Missing      | Distinguish participant removal from the sending line leaving.                                                                                                                                                      | P1       | None                                                                            |
| `chat.created`                  | Typed Linq chat extension | Generic typed `onLinqEvent`                       | Missing      | Preserve chat identity/group metadata; no separate cache-warming public API.                                                                                                                                        | P1       | None                                                                            |
| `chat.group_name_updated`       | Typed Linq chat extension | Generic typed `onLinqEvent`                       | Missing      | Observe typed group-management outcomes; do not promise exact request correlation without a provider key.                                                                                                           | P1       | None                                                                            |
| `chat.group_icon_updated`       | Typed Linq chat extension | Generic typed `onLinqEvent`                       | Missing      | Observe typed group-management outcomes; do not promise exact request correlation without a provider key.                                                                                                           | P1       | None                                                                            |
| `chat.group_name_update_failed` | Typed Linq chat extension | Generic typed `onLinqEvent`                       | Missing      | Preserve safe async failure reason/trace.                                                                                                                                                                           | P1       | None                                                                            |
| `chat.group_icon_update_failed` | Typed Linq chat extension | Generic typed `onLinqEvent`                       | Missing      | Preserve safe async failure reason/trace.                                                                                                                                                                           | P1       | None                                                                            |
| `chat.background_updated`       | Typed Linq chat extension | Generic typed `onLinqEvent`                       | Missing      | No standard Chat SDK equivalent; retain full typed payload.                                                                                                                                                         | P2       | None                                                                            |
| `chat.background_update_failed` | Typed Linq chat extension | Generic typed `onLinqEvent`                       | Missing      | Enum/prose exists but no authoritative payload schema/example; preserve authenticated `data` losslessly without invented fields.                                                                                    | P2       | Inventory drift coverage only                                                   |
| `chat.typing_indicator.started` | Typed Linq chat extension | Generic typed `onLinqEvent`                       | Missing      | Chat SDK has no standard receive-typing handler.                                                                                                                                                                    | P1       | None                                                                            |
| `chat.typing_indicator.stopped` | Typed Linq chat extension | Generic typed `onLinqEvent`                       | Missing      | Preserve sender/chat identity.                                                                                                                                                                                      | P1       | None                                                                            |
| `phone_number.status_updated`   | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Preserve the envelope generically; no routing or phone-administration workflow behavior.                                                                                                                            | —        | N/A beyond generic passthrough                                                  |
| `call.initiated`                | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Call-domain workflow behavior is not adapter scope.                                                                                                                                                                 | —        | N/A beyond generic passthrough                                                  |
| `call.ringing`                  | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Call-domain workflow behavior is not adapter scope.                                                                                                                                                                 | —        | N/A beyond generic passthrough                                                  |
| `call.answered`                 | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Call-domain workflow behavior is not adapter scope.                                                                                                                                                                 | —        | N/A beyond generic passthrough                                                  |
| `call.ended`                    | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Call-domain workflow behavior is not adapter scope.                                                                                                                                                                 | —        | N/A beyond generic passthrough                                                  |
| `call.failed`                   | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Call-domain workflow behavior is not adapter scope.                                                                                                                                                                 | —        | N/A beyond generic passthrough                                                  |
| `call.declined`                 | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Call-domain workflow behavior is not adapter scope.                                                                                                                                                                 | —        | N/A beyond generic passthrough                                                  |
| `call.no_answer`                | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Call-domain workflow behavior is not adapter scope.                                                                                                                                                                 | —        | N/A beyond generic passthrough                                                  |
| `location.sharing.started`      | Typed Linq chat extension | Generic typed `onLinqEvent` + location API        | Complete     | Exposes shared-by/shared-with and optional valid consent-window timestamps. It signals sharing state, not coordinates or request correlation; hosts retrieve on demand and retain lossless `rawEvent`.              | P1       | Contract-verified fixture, malformed/future versions, route, dedupe, raw access |
| `location.sharing.stopped`      | Typed Linq chat extension | Generic typed `onLinqEvent`                       | Complete     | Exposes shared-by/shared-with only. The adapter owns no location cache to invalidate and infers neither final coordinates nor request correlation.                                                                  | P1       | Contract-verified fixture, dispatch coexistence, typed/raw access               |
| `payment.succeeded`             | Recipe                    | Generic typed `onLinqEvent` passthrough           | Missing      | Payment-acceptance recipe may correlate the verified payload; adapter adds no payment semantics.                                                                                                                    | —        | Generic passthrough + recipe docs only                                          |
| `payment.canceled`              | Recipe                    | Generic typed `onLinqEvent` passthrough           | Missing      | Payment-acceptance recipe may correlate the verified payload; adapter adds no payment semantics.                                                                                                                    | —        | Generic passthrough + recipe docs only                                          |
| `payment.expired`               | Recipe                    | Generic typed `onLinqEvent` passthrough           | Missing      | Payment-acceptance recipe may correlate the verified payload; adapter adds no payment semantics.                                                                                                                    | —        | Generic passthrough + recipe docs only                                          |
| `payment.declined`              | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Agentcard-specific lifecycle behavior is intentionally unsupported.                                                                                                                                                 | —        | N/A beyond generic passthrough                                                  |
| `payment.authorized`            | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Agentcard-specific lifecycle behavior is intentionally unsupported.                                                                                                                                                 | —        | N/A beyond generic passthrough                                                  |
| `connection.created`            | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Agentcard connection workflows are intentionally unsupported.                                                                                                                                                       | —        | N/A beyond generic passthrough                                                  |
| `connection.revoked`            | Out of scope              | Generic typed `onLinqEvent` passthrough only      | Out of scope | Agentcard connection workflows are intentionally unsupported.                                                                                                                                                       | —        | N/A beyond generic passthrough                                                  |

### Webhook transport behavior

| Capability                              | Disposition               | Adapter API                                      | Status   | Limitations / completion gap                                                                                                                                                  | Priority | Test coverage                                                            |
| --------------------------------------- | ------------------------- | ------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| Standard Webhooks verification          | Standard Chat SDK mapping | `chat.webhooks.linq(request)`                    | Complete | Adapter uses `standardwebhooks` directly. Standard is default; complete dual headers use configured authority; partial headers and failed-authority fallback are rejected.    | P0       | Contract-verified matrix; Provider-observed historical Standard delivery |
| Deprecated legacy verification          | Internal adapter behavior | `webhookVerificationMode: "legacy"`              | Partial  | Explicit migration mode only. Remove after known deployments migrate and Linq confirms no active legacy-secret requirement.                                                   | P0       | Legacy-only/dual/partial/timestamp/tamper unit contracts                 |
| Typed generic event registration        | Typed Linq chat extension | `adapter.onLinqEvent(one / many / all)`          | Complete | Verified registration/dispatch, unsubscribe, lossless future events, callback isolation, and `waitUntil` scheduling are implemented.                                          | P0       | Registry, dispatch, scheduling + public compile-time contracts           |
| Replay protection                       | Internal adapter behavior | Standard/explicit-legacy boundary                | Complete | Five-minute boundary, exact authenticated body, reference constant-time Standard comparison, and constant-time legacy comparison.                                             | P0       | Boundary, stale, tamper, wrong-secret/ID, multi-signature unit           |
| Versioned payload handling              | Internal adapter behavior | `verifyWebhook()` + standard path                | Complete | Current is normalized; older is lossless with narrow compatibility dispatch; future/unknown non-empty versions are lossless and acknowledged without current-schema dispatch. | P0       | Current/older/future/unknown/malformed unit contracts                    |
| Unknown future events                   | Internal adapter behavior | Verified result + fast acknowledgement           | Complete | Unknown current names and unsupported versions reach all-event handlers losslessly without delaying acknowledgement.                                                          | P0       | Unit verifies preservation, dispatch, and acknowledgement                |
| Event deduplication                     | Internal adapter behavior | Chat SDK state + provider/partner/event identity | Complete | Atomic one-hour claim precedes standard/generic callbacks. A claimed callback is at-most-once attempted; durable application retries require persistence before dispatch.     | P0       | First/concurrent duplicate, namespace, failure-isolation unit            |
| Fast acknowledgement/background work    | Standard Chat SDK mapping | `WebhookOptions.waitUntil`                       | Complete | Generic callbacks do not delay acknowledgement and register completion when `waitUntil` exists. Without a host hook, serverless completion is not guaranteed.                 | P0       | Unit verifies one/two-phase timing and task registration                 |
| Generic verified Linq event passthrough | Typed Linq chat extension | `onLinqEvent()` + verified dispatch              | Complete | Registration, lossless verified dispatch, dedupe, coexistence, failure isolation, and `waitUntil` scheduling are implemented.                                                 | P0       | Contract-verified ingress, dispatch, dedupe, isolation, scheduling       |
| Trusted webhook forwarding              | Internal adapter behavior | None                                             | Missing  | Deferred until an authenticated gateway use case exists; must preserve raw body, provenance, and explicit trust configuration.                                                | P2       | None                                                                     |

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
retained as a reduced recipe/contract batch and adds no runtime adapter behavior.
All runtime batches remain limited to adapter core, internal messaging behavior, a standard Chat SDK
mapping, or a genuine typed Linq chat extension.

| Batch  | Disposition(s)                                     | Scope                           | Intended outcome                                                                                                                                                                                                                                                                                                                  |
| ------ | -------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `000`  | Standard mapping + internal + native client        | Consolidated reconciliation     | **Complete.** Latest dependencies, adapter-owned Standard/explicit-legacy ingress, standard reply/read, typed fixtures, CI, OpenAPI inventory/drift checks, and reconciled guidance.                                                                                                                                              |
| `002`  | Native Linq client                                 | Minimal public foundation       | **Complete.** Exported `LinqAdapter`, read-only `adapter.client: LinqAPIV3`, runtime identity/configuration tests, and compile-time contracts.                                                                                                                                                                                    |
| `003`  | Standard mapping + internal behavior               | Reliable existing-chat sends    | **Complete.** Central current-input limits, UUID idempotency, trace-aware shared errors, SDK-owned send retries, preparation-only cleanup, and focused `thread.post()` contracts.                                                                                                                                                 |
| `004`  | Native Linq client + recipe                        | Proactive native-client handoff | **Complete.** `004A` documents and compile-checks auto-selected and fixed-line native sends, one-key-per-logical-send guidance, post-success canonical Thread construction, immutable identity, and unsupported `openDM()`. Optional `004B` evidence remains incomplete.                                                          |
| `005`  | Standard mapping + internal + typed chat extension | Webhook/event foundation        | **Complete.** `005A`–`005C` provide typed/lossless callbacks, atomic dedupe, standard coexistence, isolation, fast acknowledgement, `waitUntil`, fixtures, and durable-ingress guidance.                                                                                                                                          |
| `006`  | Typed Linq chat extension                          | Message lifecycle               | **Complete.** `006A` types sent/delivered/read/failed observations; `006B` types edits and recovered-history markers, suppresses reconciled new-message dispatch, and documents refresh/order limits without business workflows.                                                                                                  |
| `007`  | Standard mapping + typed chat extension            | Non-lossy message model         | **Complete.** `007A` freezes transport; `007B` adds rich links/part targets; `007C` completes typed/raw inbound, defensive backward history, and card/stream contracts.                                                                                                                                                           |
| `008`  | Typed Linq chat extension                          | Contact, presence, and voice    | **Complete.** `008A` freezes the facade; `008B` implements typing stop/contact sharing and preserves part reactions; `008C` adds validated URL/attachment-ID voice memos with canonical accepted identity and lifecycle coexistence.                                                                                              |
| `009`  | Typed Linq chat extension                          | Groups and location             | **Complete.** `009A` validates group operations with lossless raw outcomes; `009B` adds location requests/snapshots and curated sharing events. Group/presence payloads remain uncurated; `009C` is optional.                                                                                                                     |
| `010`  | Standard mapping + typed chat extension            | Protocol, formatting, effects   | **Complete.** `010A` provides deterministic UTF-16 formatting/decorations; `010B` maps service/effects and rejects contradictory explicit intent before side effects. No recipient-presentation claim is made.                                                                                                                    |
| `011`  | Typed Linq chat extension                          | iMessage app messages           | **Deferred.** Experiences remain on `adapter.client`; no implementation is scheduled in the approved sequence.                                                                                                                                                                                                                    |
| `012A` | Typed Linq chat extension                          | Optional voice-memo upload      | **Deferred/optional.** Accept a raw Chat SDK `FileUpload` as a `sendVoiceMemo()` source for generated or TTS audio without public hosting. Do not add readiness polling, workflow retries/recovery, retention policy, automatic deletion, or streaming without demonstrated need.                                                 |
| `013`  | Standard mapping + internal + typed chat extension | Remaining parity cleanup        | **Partial.** `013A` contract-verifies direct/group standard start typing. `013B` contract-verifies shared error handling for thread/history/message retrieval, standard edits, and whole-message reactions while preserving refresh `404` semantics. `013C` curated group/presence events remains deferred without consumer need. |

`Complete` means the adapter-owned implementation, contracts, tests, and documentation are done.
Provider, device, and host evidence is recorded with the labels above and does not universally
control capability status. Do not overstate a provider-visible or device-visible claim merely
because its local translation is complete.

Batch `002` exposes an already-configured client reference without calling an endpoint or adding
device behavior. Linq owns operation-level coverage for native-client rows; the adapter boundary is
covered by runtime identity/configuration tests and compile-time public-surface contracts.

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
