import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import { Chat } from "chat";
import type { StateAdapter } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter } from "../src/index.js";
import historyFixture from "./fixtures/message-history-fidelity.json";

const CHAT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_ID = `linq:${CHAT_ID}`;
const MESSAGE_ID = "opaque-message-id";

type StandardOperation =
  | "fetchThread"
  | "fetchMessages"
  | "fetchMessage"
  | "editMessage"
  | "addReaction"
  | "removeReaction";

describe("standard operation reliability", () => {
  it("preserves exact SDK calls, canonical identities, and raw provider facts", async () => {
    const harness = createHarness();

    const thread = await harness.adapter.fetchThread(THREAD_ID);
    const history = await harness.adapter.fetchMessages(THREAD_ID, {
      cursor: "cursor-newer",
      limit: 25,
    });
    const refreshed = await harness.adapter.fetchMessage(THREAD_ID, MESSAGE_ID);
    const edited = await harness.adapter.editMessage(THREAD_ID, MESSAGE_ID, {
      markdown: "**Edited** text",
    });
    await harness.adapter.addReaction(THREAD_ID, MESSAGE_ID, "heart");
    await harness.adapter.removeReaction(THREAD_ID, MESSAGE_ID, "heart");

    expect(harness.retrieveChat).toHaveBeenCalledWith(CHAT_ID);
    expect(thread).toMatchObject({
      id: THREAD_ID,
      channelId: THREAD_ID,
      isDM: true,
      metadata: { chat: harness.chatResponse },
    });
    expect(harness.listMessages).toHaveBeenCalledWith(CHAT_ID, {
      cursor: "cursor-newer",
      limit: 25,
    });
    expect(history.messages[0]).toMatchObject({
      id: historyFixture.messages[0]?.id,
      threadId: THREAD_ID,
      raw: historyFixture.messages[0],
    });
    expect(history.nextCursor).toBe("cursor-older");
    expect(harness.retrieveMessage).toHaveBeenCalledWith(MESSAGE_ID);
    expect(refreshed).toMatchObject({
      id: MESSAGE_ID,
      threadId: THREAD_ID,
      raw: harness.retrieveResponse,
    });
    expect(harness.updateMessage).toHaveBeenCalledWith(MESSAGE_ID, {
      part_index: 0,
      text: "Edited text",
    });
    expect(edited).toEqual({ id: MESSAGE_ID, threadId: THREAD_ID, raw: harness.editResponse });
    expect(harness.react).toHaveBeenNthCalledWith(1, MESSAGE_ID, {
      operation: "add",
      type: "love",
    });
    expect(harness.react).toHaveBeenNthCalledWith(2, MESSAGE_ID, {
      operation: "remove",
      type: "love",
    });
  });

  it.each([
    [400, ValidationError],
    [401, AuthenticationError],
    [403, PermissionError],
    [404, ResourceNotFoundError],
    [429, AdapterRateLimitError],
    [500, AdapterError],
    [undefined, NetworkError],
  ] as const)(
    "translates status %s consistently for every standard operation except refresh 404",
    async (status, ErrorType) => {
      for (const operation of standardOperations) {
        if (operation === "fetchMessage" && status === 404) continue;

        const harness = createHarness();
        const original =
          status === undefined
            ? new Error("socket closed")
            : providerError(status, status === 429 ? 1007 : 2001, `trace-${status}`, 17);
        operationMock(harness, operation).mockRejectedValueOnce(original);

        const error = await invokeOperation(harness, operation).catch((caught) => caught);

        expect(error).toBeInstanceOf(ErrorType);
        expect(error).toMatchObject({ cause: original });
        if (status !== undefined) {
          expect(error).toMatchObject({
            providerCode: status === 429 ? 1007 : 2001,
            traceId: `trace-${status}`,
          });
        }
        if (status === 429) expect(error).toMatchObject({ retryAfter: 17 });
        expect(operationMock(harness, operation)).toHaveBeenCalledOnce();
      }
    },
  );

  it("keeps provider 404 refresh behavior as null without weakening other not-found errors", async () => {
    const refresh = createHarness();
    refresh.retrieveMessage.mockRejectedValueOnce(providerError(404, 2001, "trace-refresh"));
    await expect(refresh.adapter.fetchMessage(THREAD_ID, MESSAGE_ID)).resolves.toBeNull();

    const history = createHarness();
    history.listMessages.mockRejectedValueOnce(providerError(404, 2001, "trace-history"));
    await expect(history.adapter.fetchMessages(THREAD_ID)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it("returns null when a global message ID belongs to a different chat", async () => {
    const harness = createHarness();
    harness.retrieveMessage.mockResolvedValueOnce({
      ...historyFixture.messages[0],
      id: MESSAGE_ID,
      chat_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    await expect(harness.adapter.fetchMessage(THREAD_ID, MESSAGE_ID)).resolves.toBeNull();
    expect(harness.retrieveMessage).toHaveBeenCalledWith(MESSAGE_ID);
  });

  it("never fabricates refreshed message facts from a malformed provider row", async () => {
    const harness = createHarness();
    harness.retrieveMessage.mockResolvedValueOnce({
      ...historyFixture.messages[0],
      id: MESSAGE_ID,
      sent_at: "2026-02-30T00:00:00Z",
      created_at: null,
    });

    await expect(harness.adapter.fetchMessage(THREAD_ID, MESSAGE_ID)).rejects.toThrow(
      "invalid response while attempting to retrieve message",
    );
    expect(harness.retrieveMessage).toHaveBeenCalledWith(MESSAGE_ID);
  });

  it("rejects locally knowable invalid input before any provider operation", async () => {
    for (const operation of standardOperations) {
      const harness = createHarness();

      await expect(invokeOperation(harness, operation, "other:chat-id")).rejects.toBeInstanceOf(
        Error,
      );
      expect(operationMock(harness, operation)).not.toHaveBeenCalled();
      expect(harness.warn).not.toHaveBeenCalled();
    }

    const edit = createHarness();
    await expect(edit.adapter.editMessage(THREAD_ID, MESSAGE_ID, "")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(edit.updateMessage).not.toHaveBeenCalled();
    expect(edit.warn).not.toHaveBeenCalled();

    const reaction = createHarness();
    await expect(reaction.adapter.addReaction(THREAD_ID, MESSAGE_ID, "   ")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(reaction.adapter.removeReaction(THREAD_ID, MESSAGE_ID, "")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(reaction.react).not.toHaveBeenCalled();
    expect(reaction.warn).not.toHaveBeenCalled();
  });

  it("surfaces translated edit and reaction failures through ordinary Chat SDK messages", async () => {
    const harness = createHarness();
    const chat = new Chat({
      adapters: { linq: harness.adapter },
      logger: "silent",
      state: stateStub(),
      userName: "standard-operation-test",
    });
    await chat.initialize();
    const sent = await chat.thread(THREAD_ID).post("original");

    harness.updateMessage.mockRejectedValueOnce(providerError(403, 2001, "trace-edit"));
    await expect(sent.edit("edited")).rejects.toBeInstanceOf(PermissionError);

    harness.react.mockRejectedValueOnce(providerError(429, 1007, "trace-reaction", 17));
    await expect(sent.addReaction("heart")).rejects.toBeInstanceOf(AdapterRateLimitError);

    expect(harness.updateMessage).toHaveBeenCalledWith("sent-message", {
      part_index: 0,
      text: "edited",
    });
    expect(harness.react).toHaveBeenCalledWith("sent-message", {
      operation: "add",
      type: "love",
    });
  });
});

const standardOperations: StandardOperation[] = [
  "fetchThread",
  "fetchMessages",
  "fetchMessage",
  "editMessage",
  "addReaction",
  "removeReaction",
];

function createHarness() {
  const adapter = createLinqAdapter({
    apiKey: "test-key",
    signingSecret: "whsec_dGVzdC1zZWNyZXQ=",
  });
  const chatResponse = { display_name: "Test chat", id: CHAT_ID, is_group: false };
  const editResponse = {
    chat_id: CHAT_ID,
    created_at: "2026-08-20T00:00:00.000Z",
    delivery_status: "sent",
    id: MESSAGE_ID,
    is_from_me: true,
    is_read: false,
    parts: [],
    sent_at: "2026-08-20T00:00:00.000Z",
  };
  const retrieveChat = vi.fn().mockResolvedValue(chatResponse);
  const listMessages = vi.fn().mockResolvedValue({
    messages: [historyFixture.messages[0]],
    next_cursor: historyFixture.next_cursor,
  });
  const retrieveResponse = { ...historyFixture.messages[0], id: MESSAGE_ID };
  const retrieveMessage = vi.fn().mockResolvedValue(retrieveResponse);
  const updateMessage = vi.fn().mockResolvedValue(editResponse);
  const react = vi.fn().mockResolvedValue({ message: "Reaction processed", status: "ok" });
  const warn = vi.fn();
  const send = vi.fn().mockResolvedValue({
    chat_id: CHAT_ID,
    message: {
      created_at: "2026-08-20T00:00:00.000Z",
      delivery_status: "queued",
      id: "sent-message",
      is_read: false,
      parts: [],
      sent_at: null,
    },
  });

  Object.assign(adapter.client, {
    chats: { messages: { list: listMessages, send }, retrieve: retrieveChat },
    messages: { addReaction: react, retrieve: retrieveMessage, update: updateMessage },
  });
  (adapter as unknown as { logger: { warn: typeof warn } }).logger = { warn };

  return {
    adapter,
    chatResponse,
    editResponse,
    listMessages,
    react,
    retrieveChat,
    retrieveMessage,
    retrieveResponse,
    send,
    updateMessage,
    warn,
  };
}

type Harness = ReturnType<typeof createHarness>;

function operationMock(harness: Harness, operation: StandardOperation) {
  switch (operation) {
    case "fetchThread":
      return harness.retrieveChat;
    case "fetchMessages":
      return harness.listMessages;
    case "fetchMessage":
      return harness.retrieveMessage;
    case "editMessage":
      return harness.updateMessage;
    case "addReaction":
    case "removeReaction":
      return harness.react;
  }
}

function invokeOperation(
  harness: Harness,
  operation: StandardOperation,
  threadId = THREAD_ID,
): Promise<unknown> {
  switch (operation) {
    case "fetchThread":
      return harness.adapter.fetchThread(threadId);
    case "fetchMessages":
      return harness.adapter.fetchMessages(threadId);
    case "fetchMessage":
      return harness.adapter.fetchMessage(threadId, MESSAGE_ID);
    case "editMessage":
      return harness.adapter.editMessage(threadId, MESSAGE_ID, "edited");
    case "addReaction":
      return harness.adapter.addReaction(threadId, MESSAGE_ID, "heart");
    case "removeReaction":
      return harness.adapter.removeReaction(threadId, MESSAGE_ID, "heart");
  }
}

function providerError(status: number, code: number, traceId: string, retryAfter?: number): Error {
  const headers = new Headers({ "x-trace-id": traceId });
  if (retryAfter !== undefined) headers.set("retry-after", String(retryAfter));

  return Object.assign(new Error(`Linq HTTP ${status}`), {
    error: {
      error: { code, message: `Provider error ${code}`, retry_after: retryAfter, status },
      success: false,
      trace_id: traceId,
    },
    headers,
    status,
  });
}

function stateStub(): StateAdapter {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  } as unknown as StateAdapter;
}
