import { Chat } from "chat";
import type { StateAdapter } from "chat";
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
      is_group: false,
      message: {
        id: "outbound-message-id",
        created_at: "2026-08-22T10:00:00.123456789Z",
        sent_at: null,
      },
    });
    injectClient(adapter, { messages: { create } });

    const threadId = await adapter.openDM(HANDLE);
    const result = await adapter.postMessage(threadId, "hello");

    expect(create).toHaveBeenCalledWith({
      to: [HANDLE],
      message: {
        idempotency_key: expect.any(String),
        parts: [{ type: "text", value: "hello" }],
      },
    });
    expect(result.threadId).toBe("linq:3caaf1a0-ef9f-46e0-8c22-31e82c8514dc");
    expect(result.id).toBe("outbound-message-id");
    expect(adapter.isDM(result.threadId)).toBe(true);
  });

  it("still sends to an existing chat through the chat-scoped endpoint", async () => {
    const adapter = createTestAdapter();
    const send = vi.fn().mockResolvedValue({
      chat_id: "chat-123",
      message: {
        id: "outbound-message-id",
        created_at: "2026-08-22T10:00:00.123456789Z",
        sent_at: null,
      },
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

  it("boots through the concrete adapter and continues on a canonical Chat thread", async () => {
    const adapter = createTestAdapter();
    const create = vi.fn().mockResolvedValue({
      chat_id: "3caaf1a0-ef9f-46e0-8c22-31e82c8514dc",
      created_new_chat: true,
      is_group: false,
      message: {
        id: "outbound-message-id",
        created_at: "2026-08-22T10:00:00.123456789Z",
        sent_at: null,
      },
    });
    injectClient(adapter, { messages: { create } });
    const chat = createChat(adapter);
    await chat.initialize();

    const pendingId = await chat.getAdapter("linq").openDM(HANDLE);
    const pending = chat.thread(pendingId);
    const sent = await pending.post("hello");

    expect(pending.id).toBe(`linq:pending:${HANDLE}`);
    expect(sent.threadId).toBe("linq:3caaf1a0-ef9f-46e0-8c22-31e82c8514dc");
    expect(chat.thread(sent.threadId).id).toBe(sent.threadId);
    expect(adapter.isDM(sent.threadId)).toBe(true);
  });

  it("treats repeated first posts as distinct sends while returning one canonical chat", async () => {
    const adapter = createTestAdapter();
    let message = 0;
    const create = vi.fn().mockImplementation(async () => ({
      chat_id: "3caaf1a0-ef9f-46e0-8c22-31e82c8514dc",
      created_new_chat: message === 0,
      is_group: false,
      message: {
        id: `outbound-message-${++message}`,
        created_at: "2026-08-22T10:00:00.123456789Z",
        sent_at: null,
      },
    }));
    injectClient(adapter, { messages: { create } });
    const threadId = await adapter.openDM(HANDLE);

    const [first, second] = await Promise.all([
      adapter.postMessage(threadId, "first"),
      adapter.postMessage(threadId, "second"),
    ]);
    const keys = create.mock.calls.map(
      ([request]) => (request as { message: { idempotency_key: string } }).message.idempotency_key,
    );

    expect(first.threadId).toBe(second.threadId);
    expect(new Set(keys).size).toBe(2);
  });
});

function createTestAdapter() {
  return createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
}

function injectClient(adapter: unknown, client: unknown): void {
  (adapter as { apiClient: unknown }).apiClient = client;
}

function createChat(adapter: ReturnType<typeof createTestAdapter>) {
  const state = {
    appendToList: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  } as unknown as StateAdapter;

  return new Chat({
    adapters: { linq: adapter },
    logger: "silent",
    state,
    userName: "linq-open-dm-test",
  });
}
