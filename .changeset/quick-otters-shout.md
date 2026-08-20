---
"@linqapp/chat-sdk-adapter": minor
---

Report delivery status for outbound messages. `adapter.onDeliveryStatus()`
surfaces `message.sent`, `message.delivered`, `message.read`, and
`message.failed`, so a caller can tell a delivered message from one the carrier
rejected instead of treating every send as a success. Chat SDK has no
delivery-status dispatch, so this lives on the adapter — reach it with
`chat.getAdapter("linq")`.
