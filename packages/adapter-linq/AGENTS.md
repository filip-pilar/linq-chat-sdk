# Linq adapter contributor rules

`FEATURE_PARITY.md` is the authoritative scope, capability inventory, definition of done, and batch
roadmap for this package. Follow its dispositions; do not turn the adapter into a second Linq SDK.

Before changing behavior, read:

- the relevant parity rows and disposition-specific definition of done;
- the relevant current official Linq documentation and OpenAPI material linked from the parity file;
- the installed `@linqapp/sdk` types and behavior for every affected operation;
- Chat SDK's published adapter-authoring, testing, and error guidance plus the installed
  `@chat-adapter/shared` types; and
- the repository `chat-sdk` and `integrating-linq` skills.

## Required boundaries

- Apply the parity litmus test to every public method, class, error, option, and exported type.
  Prefer standard Chat SDK APIs and shared primitives; leave endpoint-shaped operations on
  read-only `adapter.client`.
- Add a Linq-specific export only for a documented semantic gap. Record why the standard Chat SDK,
  shared-adapter, and native-client alternatives are insufficient.
- Prefer `ValidationError`, `AdapterRateLimitError`, `AuthenticationError`, `PermissionError`,
  `ResourceNotFoundError`, `NetworkError`, and `AdapterError` from `@chat-adapter/shared`. Add a
  Linq-specific error only when essential metadata cannot fit the standard contract, and document
  and contract-test that exception.
- Do not duplicate official-client retries. Classify every side effect before retrying; retry only
  safe or verified-idempotent operations, reuse one idempotency value per logical operation, and
  never infer safety across endpoints.
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
