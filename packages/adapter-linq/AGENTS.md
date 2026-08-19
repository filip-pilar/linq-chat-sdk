# Linq adapter contributor rules

`FEATURE_PARITY.md` is authoritative for capability status, disposition, and parity completion.
Follow it; do not turn the adapter into a second Linq SDK.

Before changing behavior, read:

- the relevant parity rows and disposition-specific definition of done;
- the relevant current official Linq documentation and OpenAPI material linked from the parity file;
- the installed `@linqapp/sdk` types and behavior for every affected operation;
- Chat SDK's published adapter-authoring, testing, and error guidance plus the installed
  `@chat-adapter/shared` types; and
- the repository `chat-sdk` and `integrating-linq` skills.

Update every affected parity row in the same change as behavior. A capability is `Complete` when
its adapter-owned implementation, contracts, tests, and documentation are complete. Record
external evidence separately as `Documented`, `Contract-verified`, `Provider-observed`,
`Device-observed`, or `Host-staged`; sandbox, device, and host evidence are not universal gates.

## Required boundaries

- Apply the parity litmus test to every public method, class, error, option, and exported type.
  Prefer standard Chat SDK APIs and shared primitives; leave endpoint-shaped operations on
  read-only `adapter.client`.
- Add a Linq-specific export only for a documented semantic gap. Record why the standard Chat SDK,
  shared-adapter, and native-client alternatives are insufficient.
- Use Chat SDK `Thread.reply()` and `Thread.markAsRead()` for ordinary replies and read receipts.
  Linq marks an entire chat read; document that coarser provider semantic. Reserve a Linq extension
  only for part-index reply targeting or another fact the standard contract cannot carry.
- Use `@linqapp/sdk` for outbound/native operations only. Inbound Standard verification uses the
  direct `standardwebhooks` dependency and adapter-owned stable envelopes; never depend on the
  generated SDK `Webhooks` resource being exhaustive or functional.
- Standard verification is the default. Legacy verification is deprecated explicit migration
  mode. Partial Standard headers always fail, dual headers use the configured authority, and a
  failed authoritative scheme never falls back.
- Prefer `ValidationError`, `AdapterRateLimitError`, `AuthenticationError`, `PermissionError`,
  `ResourceNotFoundError`, `NetworkError`, and `AdapterError` from `@chat-adapter/shared`. Add a
  Linq-specific error only when essential metadata cannot fit the standard contract, and document
  and contract-test that exception.
- Do not duplicate official-client retries. Classify every side effect before retrying; retry only
  safe or verified-idempotent operations, reuse one idempotency value per logical operation, and
  never infer safety across endpoints.
- Keep every live/smoke provider request in TypeScript-checked source. Fixed-line operations must
  use an SDK contract that accepts `from`, verify the returned owner line, and fail closed instead
  of calling the auto-line `messages.create()` operation.
- Cleanup only resources definitely created and orphaned by the adapter. Keep cleanup best-effort
  and preserve the primary error.
- Use current official docs and installed SDK behavior/types as primary evidence. Record conflicts;
  do not invent ambiguous behavior. Separate provider-enforced constraints from reliable local
  validation and defer unverified semantics explicitly.

## Change quality

- Trace every verified constraint and risk to code, tests, documentation, or an explicit deferral.
  Update affected parity rows with the behavior change; never mark a broad row complete for partial
  path coverage.
- Preserve existing public APIs and standard Chat SDK behavior. Cover public behavior, constraints,
  error mapping, hostile input, and applicable live-device behavior according to the parity
  definition of done.
- Keep batches small, independently reviewable, application-neutral, and upstreamable. Add no
  Forma-specific assumptions, endpoint aliases, speculative APIs, or undocumented provider rules.
- Preserve the settled Batch `004` boundary: no Linq `openDM()`, provisional IDs, aliases, identity
  migration, first-send persistence/locking, Chat SDK change, or proactive adapter wrapper. Use the
  documented native-client recipe and canonical returned `chat_id`.
- Treat Batches `011` and `012` as deferred and Batch `013` as later parity cleanup unless
  the user explicitly changes scope.
