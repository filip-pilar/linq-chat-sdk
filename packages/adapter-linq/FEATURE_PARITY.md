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

| Capability                        | Status   | Evidence and boundary                                                                                                        |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Existing-chat post/reply          | Complete | `Contract-verified`; validated provider identity, idempotency, cards/files/attachments, shared errors                        |
| Edit message                      | Complete | `Contract-verified`; current provider operation is text-only                                                                 |
| Thread/history/message retrieval  | Complete | `Contract-verified`; untruthful rows omitted, full-precision stable chronology, cursors, bounded malformed-page traversal    |
| Whole-message reactions           | Complete | `Contract-verified`; ordinary Chat SDK API                                                                                   |
| Typing and mark-read              | Complete | `Contract-verified`; direct/group start typing, standard chat-wide read plus released `markRead()` alias                     |
| Inbound message/reaction dispatch | Complete | `Contract-verified`; owner-targeted native group mentions route through `onNewMention()`; malformed facts stay lossless      |
| Static cards and buffered streams | Complete | `Contract-verified`; compiled text/media rather than native interactive cards or native streaming                            |
| Inbound/outbound media            | Complete | `Contract-verified`; bounded upload fetches, literal-target/redirect checks, stable inbound identity, conservative cleanup   |
| Proactive `openDM()`              | Complete | `Contract-verified`; pending bootstrap, first-post creation, canonical returned identity, explicit immutable-thread boundary |
| Lazy/static credentials           | Complete | `Contract-verified`; per-operation lazy resolution and rotation; truthful sync/async native-client access                    |

## Linq-specific surface

| Capability                                 | Status   | Evidence and boundary                                                                                                                         |
| ------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `linqMessage(content, options)`            | Complete | `Contract-verified`; immutable options, strict current-member mentions, UTF-16 formatting, service/effect policy, standalone HTTPS rich links |
| Part-targeted replies/reactions            | Complete | `Contract-verified`; nested under `adapter.conversation()`; ordinary whole-message operations stay standard                                   |
| Stop typing/contact card                   | Complete | `Contract-verified`; acknowledgement only                                                                                                     |
| Voice memo from HTTPS URL or attachment ID | Complete | `Contract-verified`; returned IDs are acceptance facts, not delivery/presentation                                                             |
| Existing-group update/member/leave         | Complete | `Contract-verified`; acknowledgement only, no snapshot/correlation workflow                                                                   |
| Location request/retrieve                  | Complete | `Contract-verified`; consent prompt plus defensive immutable longitude-first snapshots                                                        |
| Conversation polls                         | Complete | `Documented`, `Contract-verified`; create/add/vote/retrieve, immutable validated snapshots, no retry/workflow claims                          |
| Official SDK escape hatch                  | Complete | `Contract-verified`; static `.client`, universal async `.getClient()`, no stale lazy-client cache                                             |
| Delivery-status compatibility API          | Complete | `Contract-verified`; shared authenticated lifecycle facts with typed/lossless event delivery                                                  |

## Verified webhook boundary

| Capability                                   | Status   | Evidence and boundary                                                                                            |
| -------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| Direct/trusted webhook authentication        | Complete | `Contract-verified`, `Provider-observed`; exact raw body, explicit authority, no fallback/double verification    |
| Typed/lossless event observation             | Complete | `Contract-verified`; curated projections, named canonical raw events, generic malformed/unknown/future facts     |
| Lifecycle/edit/reconciliation/location facts | Complete | `Contract-verified`; observations only, no ordering/terminal/correlation claims                                  |
| Poll event facts                             | Complete | `Documented`, `Contract-verified`; all nine current families typed/lossless, malformed curated data generic-only |
| Atomic dedupe/callback isolation/`waitUntil` | Complete | `Contract-verified`; per-event listener snapshots and rejected callbacks do not delay acknowledgement            |
| Missing current chat kind                    | Complete | `Contract-verified`; reuse a known fact or retain raw observation without lookup/guess/standard dispatch         |
| OpenAPI event-name drift                     | Complete | `Contract-verified`; only the canonical enum backing `onLinqEvent()` is inventoried                              |

## Identity and media notes

- Emit only `linq:{chatId}`. Persisted released `linq:{chatId}:dm/group` IDs remain decode-only
  compatibility and are not an active identity feature.
- Inbound voice memos are supported as ordinary downloadable audio attachments. The canonical
  inbound media schema does not reliably distinguish them from other audio files.
- Inbound `text/vcard` media is a standard downloadable file attachment. Parsing contacts and
  address-book mutation remain application-owned.
- The adapter validates focused security/correctness constraints for network operations it performs,
  including locally sensitive literal upload targets. Host
  request limits, rate limiting, durable queues, persistence, and availability policy terminate at
  the adapter boundary. Linq upload-host integrity and hostname resolution remain provider/host
  network concerns.
- Static direct webhook secrets are validated exactly with `standardwebhooks`; lazy secrets are
  validated per request, while explicit trusted forwarding remains an exclusive authority.
- Provider responses are checked only for facts required by public adapter results. Malformed
  post-acceptance responses do not trigger retries or uncertain-send cleanup.
- Historical selective provider/device observations confirmed Standard Webhook compatibility,
  exact-line routing, unsupported request fields, and representative message/media behavior. Those
  observations are supplementary and no executable live harness is maintained here.

## Deferred or excluded

| Item                                                               | Disposition                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| iMessage app messages                                              | Deferred; no adapter-owned consumer need established                          |
| Raw `FileUpload` voice-memo source                                 | Optional; existing URL/attachment-ID sources are complete                     |
| Large-file streaming/upload recovery/retention workflows           | Deferred or application-owned; require demonstrated need                      |
| Curated group/presence event models                                | Deferred; lossless generic event access is available                          |
| Account/subscription/admin endpoint wrappers                       | Use `.client` / `getClient()`                                                 |
| Chat-background wrapper                                            | Use native client for now; guide/request enum mismatch remains provider-owned |
| AI-agent poll/mention tools                                        | Application-owned authorization, prompts, and tool policy                     |
| Provider delivery, retries, ordering, device presentation          | Provider-owned                                                                |
| Queues, databases, polling, transcription, identity/product policy | Host/application-owned                                                        |
| Provider/device/live smoke                                         | Optional evidence only; not an adapter completion gate                        |

## Maintenance rule

Keep the adapter general-purpose. Add a public Linq-specific contract only when standard Chat SDK
cannot express the semantic, the official client alone is insufficient ergonomically, and durable
cross-application value is demonstrated. The canonical OpenAPI event enum is checked because it
backs a public type; provider-wide endpoint counts and examples are intentionally not tracked.
