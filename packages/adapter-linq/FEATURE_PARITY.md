# Linq adapter capability matrix

This inventory covers adapter-owned behavior, not every Linq endpoint. `Complete` means the local
implementation, public contract, deterministic tests, and durable documentation are complete.

Evidence labels:

- `Documented`: supported by current official Linq/Chat SDK contracts.
- `Contract-verified`: checked deterministically against installed types, fixtures, and integration
  contracts.
- `Provider-observed`, `Device-observed`, `Host-staged`: supplementary external evidence, never a
  universal completion gate.

## Standard Chat SDK surface

| Capability                        | Status   | Evidence and boundary                                                                                                                  |
| --------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Existing-chat post/reply          | Complete | `Contract-verified`; canonical identity, idempotency, cards/files/attachments, shared errors                                           |
| Edit message                      | Complete | `Contract-verified`; current provider operation is text-only                                                                           |
| Thread/history/message retrieval  | Complete | `Contract-verified`; defensive rows/parts, stable oldest-first valid timestamps, cursor preservation, bounded malformed-page traversal |
| Whole-message reactions           | Complete | `Contract-verified`; ordinary Chat SDK API                                                                                             |
| Typing and mark-read              | Complete | `Contract-verified`; direct/group start typing, chat-wide read acknowledgement                                                         |
| Inbound message/reaction dispatch | Complete | `Contract-verified`; unknown/malformed facts do not corrupt sibling dispatch                                                           |
| Static cards and buffered streams | Complete | `Contract-verified`; compiled text/media rather than native interactive cards or native streaming                                      |
| Inbound/outbound media            | Complete | `Contract-verified`; bounded upload fetches, literal-target/redirect checks, stable inbound identity, conservative cleanup             |
| Proactive `openDM()`              | Complete | `Contract-verified`; pending bootstrap, first-post creation, canonical returned identity, explicit immutable-thread boundary           |
| Lazy/static credentials           | Complete | `Contract-verified`; per-operation lazy resolution and rotation; truthful sync/async native-client access                              |

## Linq-specific surface

| Capability                                 | Status   | Evidence and boundary                                                                                                             |
| ------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `linqMessage(content, options)`            | Complete | `Contract-verified`; immutable options, deterministic text/UTF-16 decorations, service/effect policy, standalone HTTPS rich links |
| Part-targeted replies/reactions            | Complete | `Contract-verified`; nested under `adapter.conversation()`; ordinary whole-message operations stay standard                       |
| Stop typing/contact card                   | Complete | `Contract-verified`; acknowledgement only                                                                                         |
| Voice memo from HTTPS URL or attachment ID | Complete | `Contract-verified`; returned IDs are acceptance facts, not delivery/presentation                                                 |
| Existing-group update/member/leave         | Complete | `Contract-verified`; acknowledgement only, no snapshot/correlation workflow                                                       |
| Location request/retrieve                  | Complete | `Contract-verified`; consent prompt plus defensive immutable longitude-first snapshots                                            |
| Official SDK escape hatch                  | Complete | `Contract-verified`; static `.client`, universal async `.getClient()`, no stale lazy-client cache                                 |
| Delivery-status compatibility API          | Complete | `Contract-verified`; shared authenticated lifecycle facts with typed/lossless event delivery                                      |

## Verified webhook boundary

| Capability                                   | Status   | Evidence and boundary                                                                                         |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| Direct/trusted webhook authentication        | Complete | `Contract-verified`, `Provider-observed`; exact raw body, explicit authority, no fallback/double verification |
| Typed/lossless event observation             | Complete | `Contract-verified`; truthful current projections plus immutable malformed/unknown/future raw events          |
| Lifecycle/edit/reconciliation/location facts | Complete | `Contract-verified`; observations only, no ordering/terminal/correlation claims                               |
| Atomic dedupe/callback isolation/`waitUntil` | Complete | `Contract-verified`; rejected delivery/generic callbacks are isolated without delaying acknowledgement        |
| Missing current chat kind                    | Complete | `Contract-verified`; reuse a known fact or retain raw observation without lookup/guess/standard dispatch      |
| OpenAPI event-name drift                     | Complete | `Contract-verified`; only the canonical enum backing `onLinqEvent()` is inventoried                           |

## Identity and media notes

- Emit only `linq:{chatId}`. Persisted released `linq:{chatId}:dm/group` IDs remain decode-only
  compatibility and are not an active identity feature.
- Inbound voice memos are supported as ordinary downloadable audio attachments. The canonical
  inbound media schema does not reliably distinguish them from other audio files.
- The adapter validates security/correctness constraints for network operations it performs. Host
  request limits, rate limiting, durable queues, persistence, and availability policy terminate at
  the adapter boundary. Linq upload-host integrity and hostname resolution remain provider/host
  network concerns.
- Historical selective provider/device observations confirmed Standard Webhook compatibility,
  exact-line routing, unsupported request fields, and representative message/media behavior. Those
  observations are supplementary and no executable live harness is maintained here.

## Deferred or excluded

| Item                                                               | Disposition                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| iMessage app messages (`011`)                                      | Deferred; no adapter-owned consumer need established      |
| Raw `FileUpload` voice-memo source (`012A`)                        | Optional; existing URL/attachment-ID sources are complete |
| Large-file streaming/upload recovery/retention workflows           | Deferred or application-owned; require demonstrated need  |
| Curated group/presence event models (`013C`)                       | Deferred; lossless generic event access is available      |
| Account/subscription/admin endpoint wrappers                       | Use `.client` / `getClient()`                             |
| Provider delivery, retries, ordering, device presentation          | Provider-owned                                            |
| Queues, databases, polling, transcription, identity/product policy | Host/application-owned                                    |
| Provider/device/live smoke                                         | Optional evidence only; not an adapter completion gate    |

## Maintenance rule

Keep the adapter general-purpose. Add a public Linq-specific contract only when standard Chat SDK
cannot express the semantic, the official client alone is insufficient ergonomically, and durable
cross-application value is demonstrated. The canonical OpenAPI event enum is checked because it
backs a public type; provider-wide endpoint counts and examples are intentionally not tracked.
