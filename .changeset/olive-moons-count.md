---
"@linqapp/chat-sdk-adapter": patch
---

Record a disposition for every Linq webhook event type, so an
`@linqapp/sdk` upgrade that adds events fails typecheck instead of passing
unnoticed.
