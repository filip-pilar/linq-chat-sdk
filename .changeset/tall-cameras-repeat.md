---
"@linqapp/chat-sdk-adapter": minor
---

Implement `markRead()`. Chat SDK's read receipts now reach Linq, so a bot that
processes a message can clear the unread badge on the recipient's device.
Linq marks a whole chat read rather than up to a specific message, so the
`messageId` argument is accepted for interface compatibility and ignored.
