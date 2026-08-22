import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter } from "../src/adapter";

const SIGNING_SECRET = "whsec_c2hoaC10aGlzLWlzLWEtdGVzdC1zZWNyZXQtdmFsdWU=";
const API_KEY = "test_linq_api_key";
const HANDLE = "+12025550147";

describe("LinqAdapter.openDM", () => {
  it("returns a pending thread ID for a handle with no chat yet", async () => {
    const adapter = createTestAdapter();

    await expect(adapter.openDM(HANDLE)).resolves.toBe(`linq:pending:${HANDLE}`);
  });

  it("is deterministic, so the same handle always addresses the same thread", async () => {
    const adapter = createTestAdapter();

    expect(await adapter.openDM(HANDLE)).toBe(await adapter.openDM(HANDLE));
  });

  it("rejects a blank handle", async () => {
    const adapter = createTestAdapter();

    await expect(adapter.openDM("   ")).rejects.toThrow("Linq openDM requires a handle.");
  });

  it("creates the chat on the first post and reports the real thread ID", async () => {
    const adapter = createTestAdapter();
    const create = vi.fn().mockResolvedValue({
      chat_id: "3caaf1a0-ef9f-46e0-8c22-31e82c8514dc",
      created_new_chat: true,
      message: { id: "outbound-message-id" },
    });
    injectClient(adapter, { messages: { create } });

    const threadId = await adapter.openDM(HANDLE);
    const result = await adapter.postMessage(threadId, "hello");

    expect(create).toHaveBeenCalledWith({
      to: [HANDLE],
      message: { parts: [{ type: "text", value: "hello" }] },
    });
    expect(result.threadId).toBe("linq:3caaf1a0-ef9f-46e0-8c22-31e82c8514dc");
    expect(result.id).toBe("outbound-message-id");
  });

  it("still sends to an existing chat through the chat-scoped endpoint", async () => {
    const adapter = createTestAdapter();
    const send = vi.fn().mockResolvedValue({
      chat_id: "chat-123",
      message: { id: "outbound-message-id" },
    });
    const create = vi.fn();
    injectClient(adapter, { chats: { messages: { send } }, messages: { create } });

    await adapter.postMessage("linq:chat-123", "hello");

    expect(send).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it("explains itself when an operation needs a chat that does not exist yet", async () => {
    const adapter = createTestAdapter();
    const threadId = await adapter.openDM(HANDLE);

    await expect(adapter.fetchMessages(threadId)).rejects.toThrow(
      /has no chat yet.*send a message first/i,
    );
  });
});

function createTestAdapter() {
  return createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
}

function injectClient(adapter: unknown, client: unknown): void {
  (adapter as { apiClient: unknown }).apiClient = client;
}
