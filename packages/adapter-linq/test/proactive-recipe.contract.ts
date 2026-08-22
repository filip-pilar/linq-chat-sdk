import type { Chat, Thread } from "chat";

import type { LinqAdapter } from "../src/index.js";

/** Compile-only mirror of the documented auto-selected sender recipe. */
async function sendWithAutoSelectedSender(
  adapter: LinqAdapter,
  chat: Chat<{ linq: LinqAdapter }>,
  recipient: string,
  logicalSendId: string,
): Promise<void> {
  const result = await adapter.client.messages.create({
    to: [recipient],
    message: {
      idempotency_key: logicalSendId,
      parts: [{ type: "text", value: "Hello from Linq" }],
    },
  });

  const canonicalThreadId: `linq:${string}` = `linq:${result.chat_id}`;
  const canonicalThread: Thread = chat.thread(canonicalThreadId);
  await canonicalThread.subscribe();
  await canonicalThread.post("A normal follow-up through Chat SDK");
  void canonicalThread.messages;
  void result.message.id;
}

/** Compile-only mirror of the documented explicit fixed-line recipe. */
async function sendFromFixedLine(
  adapter: LinqAdapter,
  chat: Chat<{ linq: LinqAdapter }>,
  from: string,
  recipient: string,
  logicalSendId: string,
): Promise<void> {
  const result = await adapter.client.chats.create({
    from,
    to: [recipient],
    message: {
      idempotency_key: logicalSendId,
      parts: [{ type: "text", value: "Hello from the selected Linq line" }],
    },
  });

  const canonicalThreadId: `linq:${string}` = `linq:${result.chat.id}`;
  const canonicalThread: Thread = chat.thread(canonicalThreadId);
  await canonicalThread.subscribe();
  await canonicalThread.post("A normal follow-up through Chat SDK");
  void result.chat.message.id;
}

function assertIdentityContracts(adapter: LinqAdapter, thread: Thread): void {
  void adapter.openDM("+15550000001");

  // @ts-expect-error -- Chat SDK Thread identity is immutable and cannot adopt a returned chat ID.
  thread.id = "linq:11111111-1111-1111-1111-111111111111";
}

void sendWithAutoSelectedSender;
void sendFromFixedLine;
void assertIdentityContracts;
