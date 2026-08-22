import { AdapterError } from "@chat-adapter/shared";
import type { Thread } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter, type LinqAdapter } from "../src/index.js";

const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CHAT_ID = "22222222-2222-4222-8222-222222222222";
const THREAD_ID = `linq:${CHAT_ID}`;
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const ATTACHMENT_ID = "44444444-4444-4444-8444-444444444444";
const SIGNING_SECRET = "whsec_dGVzdC1zZWNyZXQ=";

describe("provider response validation", () => {
  it.each([
    ["null response", null],
    ["missing message", { chat_id: CHAT_ID }],
    ["null message id", sendResponse({ id: null })],
    ["missing message id", sendResponse({ id: undefined })],
    ["empty message id", sendResponse({ id: "" })],
    ["whitespace-altered message id", sendResponse({ id: ` ${MESSAGE_ID}` })],
    ["numeric message id", sendResponse({ id: 42 })],
    ["object message id", sendResponse({ id: {} })],
    ["missing chat id", { ...sendResponse(), chat_id: undefined }],
    ["null chat id", { ...sendResponse(), chat_id: null }],
    ["empty chat id", { ...sendResponse(), chat_id: "" }],
    ["numeric chat id", { ...sendResponse(), chat_id: 42 }],
    ["object chat id", { ...sendResponse(), chat_id: {} }],
    ["cross-chat identity", { ...sendResponse(), chat_id: OTHER_CHAT_ID }],
  ])("rejects an existing-chat send with %s without retrying", async (_label, response) => {
    const adapter = testAdapter();
    const send = vi.fn().mockResolvedValue(response);
    Object.assign(adapter.client, { chats: { messages: { send } } });

    const error = await adapter.postMessage(THREAD_ID, "hello").catch((caught) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ adapter: "linq", cause: expect.any(TypeError) });
    expect(String(error)).not.toContain(SIGNING_SECRET);
    expect(send).toHaveBeenCalledOnce();
  });

  it("requires pending first sends to establish a canonical provider chat identity", async () => {
    const adapter = testAdapter();
    const create = vi
      .fn()
      .mockResolvedValueOnce({ ...sendResponse(), chat_id: undefined, is_group: false })
      .mockResolvedValueOnce({ ...sendResponse(), chat_id: OTHER_CHAT_ID, is_group: false });
    Object.assign(adapter.client, { messages: { create } });
    const pending = await adapter.openDM("+15550000001");

    await expect(adapter.postMessage(pending, "first")).rejects.toBeInstanceOf(AdapterError);
    await expect(adapter.postMessage(pending, "second")).resolves.toMatchObject({
      id: MESSAGE_ID,
      threadId: `linq:${OTHER_CHAT_ID}`,
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, "false", 0, {}])(
    "rejects pending first-send chat kind %j without inventing canonical state",
    async (isGroup) => {
      const adapter = testAdapter();
      const create = vi.fn().mockResolvedValue({ ...sendResponse(), is_group: isGroup });
      Object.assign(adapter.client, { messages: { create } });
      const pending = await adapter.openDM("+15550000001");

      await expect(adapter.postMessage(pending, "first")).rejects.toBeInstanceOf(AdapterError);
      expect(create).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, null, "", " pending", "pending", "chat:kind", 42, {}])(
    "rejects pending first-send canonical chat identity %j",
    async (chatId) => {
      const adapter = testAdapter();
      const create = vi
        .fn()
        .mockResolvedValue({ ...sendResponse(), chat_id: chatId, is_group: false });
      Object.assign(adapter.client, { messages: { create } });
      const pending = await adapter.openDM("+15550000001");

      await expect(adapter.postMessage(pending, "first")).rejects.toBeInstanceOf(AdapterError);
      expect(create).toHaveBeenCalledOnce();
    },
  );

  it("validates only send facts used by the returned public identity", async () => {
    const adapter = testAdapter();
    const response = sendResponse({ sent_at: "not-a-timestamp", created_at: null });
    const send = vi.fn().mockResolvedValue(response);
    Object.assign(adapter.client, { chats: { messages: { send } } });

    await expect(adapter.postMessage(THREAD_ID, "hello")).resolves.toEqual({
      id: MESSAGE_ID,
      threadId: THREAD_ID,
      raw: response,
    });
  });

  it.each([
    ["message id", { ...retrievedMessage(), id: null }],
    ["chat id", { ...retrievedMessage(), chat_id: null }],
  ])(
    "rejects malformed edit response %s through the protocol boundary",
    async (_label, response) => {
      const adapter = testAdapter();
      const update = vi.fn().mockResolvedValue(response);
      Object.assign(adapter.client, { messages: { update } });

      await expect(adapter.editMessage(THREAD_ID, MESSAGE_ID, "edited")).rejects.toBeInstanceOf(
        AdapterError,
      );
      expect(update).toHaveBeenCalledOnce();
    },
  );

  it("validates only edit facts used by the returned RawMessage identity", async () => {
    const adapter = testAdapter();
    const response = {
      ...retrievedMessage(),
      is_from_me: "not-projected",
      created_at: "not-projected",
      sent_at: null,
    };
    const update = vi.fn().mockResolvedValue(response);
    Object.assign(adapter.client, { messages: { update } });

    await expect(adapter.editMessage(THREAD_ID, MESSAGE_ID, "edited")).resolves.toEqual({
      id: MESSAGE_ID,
      threadId: THREAD_ID,
      raw: response,
    });
  });

  it("validates thread and refreshed-message identity facts before returning public objects", async () => {
    const adapter = testAdapter();
    const retrieveChat = vi
      .fn()
      .mockResolvedValueOnce({ id: CHAT_ID, is_group: "false", display_name: "Chat" })
      .mockResolvedValueOnce({ id: OTHER_CHAT_ID, is_group: false, display_name: "Chat" });
    const retrieveMessage = vi
      .fn()
      .mockResolvedValueOnce({ ...retrievedMessage(), id: OTHER_CHAT_ID })
      .mockResolvedValueOnce({ ...retrievedMessage(), chat_id: OTHER_CHAT_ID });
    Object.assign(adapter.client, {
      chats: { retrieve: retrieveChat },
      messages: { retrieve: retrieveMessage },
    });

    await expect(adapter.fetchThread(THREAD_ID)).rejects.toBeInstanceOf(AdapterError);
    await expect(adapter.fetchThread(THREAD_ID)).rejects.toBeInstanceOf(AdapterError);
    await expect(adapter.fetchMessage(THREAD_ID, MESSAGE_ID)).rejects.toBeInstanceOf(AdapterError);
    await expect(adapter.fetchMessage(THREAD_ID, MESSAGE_ID)).resolves.toBeNull();
  });

  it.each([
    ["null page", null],
    ["missing messages", { next_cursor: null }],
    ["non-array messages", { messages: {}, next_cursor: null }],
    ["malformed cursor", { messages: [], next_cursor: 42 }],
  ])(
    "rejects malformed history page container %s without another request",
    async (_label, page) => {
      const adapter = testAdapter();
      const list = vi.fn().mockResolvedValue(page);
      Object.assign(adapter.client, { chats: { messages: { list } } });

      await expect(adapter.fetchMessages(THREAD_ID)).rejects.toBeInstanceOf(AdapterError);
      expect(list).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["response", null],
    ["voice memo", {}],
    ["message id", voiceMemoResponse({ id: null })],
    ["chat id", voiceMemoResponse({}, { id: null })],
    ["cross-chat id", voiceMemoResponse({}, { id: OTHER_CHAT_ID })],
    ["chat kind", voiceMemoResponse({}, { is_group: "false" })],
    ["attachment id", voiceMemoResponse({}, {}, { id: null })],
  ])("rejects malformed voice-memo %s facts", async (_label, response) => {
    const adapter = testAdapter();
    const sendVoicememo = vi.fn().mockResolvedValue(response);
    Object.assign(adapter.client, { chats: { sendVoicememo } });

    await expect(
      adapter.conversation(threadFor(adapter)).sendVoiceMemo({ attachmentId: ATTACHMENT_ID }),
    ).rejects.toBeInstanceOf(AdapterError);
    expect(sendVoicememo).toHaveBeenCalledOnce();
  });

  it("preserves canonical valid identities and immutable raw provider responses", async () => {
    const adapter = testAdapter();
    const sendRaw = sendResponse();
    const editRaw = retrievedMessage();
    const voiceRaw = voiceMemoResponse();
    Object.assign(adapter.client, {
      chats: {
        messages: { send: vi.fn().mockResolvedValue(sendRaw) },
        sendVoicememo: vi.fn().mockResolvedValue(voiceRaw),
      },
      messages: { update: vi.fn().mockResolvedValue(editRaw) },
    });

    const sent = await adapter.postMessage(THREAD_ID, "hello");
    const edited = await adapter.editMessage(THREAD_ID, MESSAGE_ID, "edited");
    expect(sent).toEqual({
      id: MESSAGE_ID,
      threadId: THREAD_ID,
      raw: sendRaw,
    });
    expect(edited).toEqual({
      id: MESSAGE_ID,
      threadId: THREAD_ID,
      raw: editRaw,
    });
    expect(Object.isFrozen(sent.raw)).toBe(true);
    expect(Object.isFrozen((sent.raw as { message: object }).message)).toBe(true);
    expect(Object.isFrozen(edited.raw)).toBe(true);
    await expect(
      adapter.conversation(threadFor(adapter)).sendVoiceMemo({ attachmentId: ATTACHMENT_ID }),
    ).resolves.toEqual({
      messageId: MESSAGE_ID,
      threadId: THREAD_ID,
      attachmentId: ATTACHMENT_ID,
    });
  });

  it("keeps lazy credential resolution and protocol failures within one send attempt", async () => {
    const credentials = vi.fn().mockResolvedValue({ apiKey: "rotating-key" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(sendResponse({ id: null })), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = createLinqAdapter({
      baseURL: "https://provider.example.test/api/partner",
      credentials,
      webhookVerifier: () => true,
    });

    try {
      await expect(adapter.postMessage(THREAD_ID, "hello")).rejects.toBeInstanceOf(AdapterError);
      expect(credentials).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [input, init] = fetchSpy.mock.calls[0] ?? [];
      if (!input) throw new Error("Expected one provider request");
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer rotating-key");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

function testAdapter(): LinqAdapter {
  return createLinqAdapter({ apiKey: "test-key", signingSecret: SIGNING_SECRET });
}

function threadFor(adapter: LinqAdapter): Thread {
  return { adapter, id: THREAD_ID } as unknown as Thread;
}

function sendResponse(messageOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chat_id: CHAT_ID,
    message: {
      created_at: "2026-08-22T10:00:00.123456789Z",
      delivery_status: "queued",
      id: MESSAGE_ID,
      is_read: false,
      parts: [],
      sent_at: null,
      ...messageOverrides,
    },
  };
}

function retrievedMessage(): Record<string, unknown> {
  return {
    chat_id: CHAT_ID,
    created_at: "2026-08-22T10:00:00.123456789Z",
    delivery_status: "sent",
    id: MESSAGE_ID,
    is_delivered: true,
    is_from_me: true,
    is_read: false,
    parts: [{ type: "text", value: "edited" }],
    sent_at: "2026-08-22T10:00:00.123456789Z",
    updated_at: "2026-08-22T10:00:01.000Z",
  };
}

function voiceMemoResponse(
  memoOverrides: Record<string, unknown> = {},
  chatOverrides: Record<string, unknown> = {},
  attachmentOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    voice_memo: {
      id: MESSAGE_ID,
      chat: { id: CHAT_ID, is_group: false, ...chatOverrides },
      voice_memo: { id: ATTACHMENT_ID, ...attachmentOverrides },
      ...memoOverrides,
    },
  };
}
