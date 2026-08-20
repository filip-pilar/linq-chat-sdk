import {
  AdapterError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import { Actions, Button, Card, Chat, NotImplementedError } from "chat";
import type { StateAdapter } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter, type LinqAdapter } from "../src/index.js";

const CHAT_ID = "11111111-1111-1111-1111-111111111111";
const GROUP_CHAT_ID = "55555555-5555-5555-5555-555555555555";
const THREAD_ID = `linq:${CHAT_ID}`;
const MESSAGE_ID = "22222222-2222-2222-2222-222222222222";
const PARENT_ID = "33333333-3333-3333-3333-333333333333";

describe("Linq conversation facade", () => {
  it.each([0, 3])(
    "replies to explicit part index %s through the Chat SDK thread",
    async (partIndex) => {
      const { adapter, chat, send } = await createHarness();
      const thread = chat.thread(THREAD_ID);
      const sent = await adapter.conversation(thread).replyToPart(PARENT_ID, partIndex, "reply");

      expect(send).toHaveBeenCalledWith(CHAT_ID, {
        message: {
          idempotency_key: expect.any(String),
          parts: [{ type: "text", value: "reply" }],
          reply_to: { message_id: PARENT_ID, part_index: partIndex },
        },
      });
      expect(sent).toMatchObject({ id: MESSAGE_ID, threadId: THREAD_ID, text: "reply" });
    },
  );

  it("preserves reply targeting through callback-card processing and normal edits", async () => {
    const { adapter, chat, send, update } = await createHarness();
    const card = Card({
      children: [
        Actions([
          Button({
            callbackUrl: "https://example.com/callback",
            id: "approve",
            label: "Approve",
            value: "order-123",
          }),
        ]),
      ],
    });
    const sent = await adapter.conversation(THREAD_ID).replyToPart(PARENT_ID, 2, card);

    expect(send.mock.calls[0]?.[1].message.reply_to).toEqual({
      message_id: PARENT_ID,
      part_index: 2,
    });
    const edited = await sent.edit("updated");
    expect(update).toHaveBeenCalledWith(MESSAGE_ID, { text: "updated", part_index: 0 });
    expect(edited).toMatchObject({ id: MESSAGE_ID, threadId: THREAD_ID, text: "updated" });

    const history = [];
    for await (const message of chat.thread(THREAD_ID).messages) history.push(message);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: MESSAGE_ID, threadId: THREAD_ID });
  });

  it("preserves omitted, zero, and nonzero part indexes for add/remove reactions", async () => {
    const { adapter, addReaction } = await createHarness();
    const conversation = adapter.conversation(THREAD_ID);

    await conversation.addReaction(MESSAGE_ID, "heart");
    await conversation.addReaction(MESSAGE_ID, "laugh", { partIndex: 0 });
    await conversation.removeReaction(MESSAGE_ID, "😍", { partIndex: 4 });

    expect(addReaction.mock.calls).toEqual([
      [MESSAGE_ID, { operation: "add", type: "love" }],
      [MESSAGE_ID, { operation: "add", type: "laugh", part_index: 0 }],
      [MESSAGE_ID, { operation: "remove", type: "custom", custom_emoji: "😍", part_index: 4 }],
    ]);
  });

  it("keeps ordinary replies and reactions on standard Chat SDK APIs", async () => {
    const { addReaction, chat, send } = await createHarness();
    const thread = chat.thread(THREAD_ID);
    const sent = await thread.reply(PARENT_ID, "ordinary reply");
    await sent.addReaction("heart");
    await sent.removeReaction("heart");

    expect(send.mock.calls[0]?.[1].message.reply_to).toEqual({ message_id: PARENT_ID });
    expect(addReaction.mock.calls).toEqual([
      [MESSAGE_ID, { operation: "add", type: "love" }],
      [MESSAGE_ID, { operation: "remove", type: "love" }],
    ]);
  });

  it("stops typing and shares the configured contact card with exact acknowledgements", async () => {
    const { adapter, chat, shareContactCard, stopTyping } = await createHarness();
    const byThread = adapter.conversation(chat.thread(THREAD_ID));
    const byId = adapter.conversation(THREAD_ID);

    await byThread.stopTyping();
    await byThread.stopTyping();
    await byId.shareContactCard();
    await byId.shareContactCard();

    expect(stopTyping.mock.calls).toEqual([[CHAT_ID], [CHAT_ID]]);
    expect(shareContactCard.mock.calls).toEqual([[CHAT_ID], [CHAT_ID]]);
  });

  it("supports stop acknowledgements for known group chats", async () => {
    const { adapter, stopTyping } = await createHarness();
    const groupThreadId = adapter.encodeThreadId({ chatId: GROUP_CHAT_ID, isGroup: true });

    await adapter.conversation(groupThreadId).stopTyping();

    expect(stopTyping).toHaveBeenCalledWith(GROUP_CHAT_ID);
  });

  it("coexists with standard start-typing, mark-read, and whole-message reactions", async () => {
    const { adapter, addReaction, chat, markAsRead, startTyping, stopTyping } =
      await createHarness();
    const thread = chat.thread(THREAD_ID);

    await thread.startTyping();
    await thread.markAsRead(MESSAGE_ID);
    await adapter.conversation(thread).stopTyping();
    const sent = await thread.post("standard reaction target");
    await sent.addReaction("heart");

    expect(startTyping).toHaveBeenCalledWith(CHAT_ID);
    expect(markAsRead).toHaveBeenCalledWith(CHAT_ID);
    expect(stopTyping).toHaveBeenCalledWith(CHAT_ID);
    expect(addReaction).toHaveBeenCalledWith(MESSAGE_ID, {
      operation: "add",
      type: "love",
    });
  });

  it.each([
    ["reply message ID", "not-a-uuid", 0],
    ["negative reply index", PARENT_ID, -1],
    ["fractional reply index", PARENT_ID, 1.5],
  ])("rejects invalid %s before provider work", async (_name, messageId, partIndex) => {
    const { adapter, addReaction, send } = await createHarness();

    await expect(
      adapter.conversation(THREAD_ID).replyToPart(messageId, partIndex, "reply"),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(send).not.toHaveBeenCalled();
    expect(addReaction).not.toHaveBeenCalled();
  });

  it.each([
    ["reaction message ID", "not-a-uuid", undefined],
    ["negative reaction index", MESSAGE_ID, -1],
    ["fractional reaction index", MESSAGE_ID, 1.5],
  ])("rejects invalid %s before provider work", async (_name, messageId, partIndex) => {
    const { adapter, addReaction, send } = await createHarness();

    await expect(
      adapter
        .conversation(THREAD_ID)
        .addReaction(messageId, "heart", partIndex === undefined ? {} : { partIndex }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(addReaction).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["", "   ", 42])("rejects hostile reaction %j before provider work", async (reaction) => {
    const { adapter, addReaction } = await createHarness();

    await expect(
      adapter.conversation(THREAD_ID).addReaction(MESSAGE_ID, reaction as string),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(addReaction).not.toHaveBeenCalled();
  });

  it("rejects hostile reply content before provider work", async () => {
    const { adapter, send } = await createHarness();

    await expect(
      adapter.conversation(THREAD_ID).replyToPart(PARENT_ID, 0, null as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "linq:not-a-uuid",
    `linq:${CHAT_ID}:dm`,
    `other:${CHAT_ID}`,
    `linq:recipient:${CHAT_ID}`,
  ])("rejects noncanonical conversation identity %s", async (threadId) => {
    const { adapter, providerIO } = await createHarness();

    expect(() => adapter.conversation(threadId)).toThrow(ValidationError);
    for (const providerCall of providerIO) expect(providerCall).not.toHaveBeenCalled();
  });

  it("rejects a Thread owned by another adapter instance", async () => {
    const first = await createHarness();
    const second = await createHarness();

    expect(() => first.adapter.conversation(second.chat.thread(THREAD_ID))).toThrow(
      ValidationError,
    );
    for (const providerCall of first.providerIO) expect(providerCall).not.toHaveBeenCalled();
  });

  it("requires Chat initialization when resolving a conversation by ID", () => {
    const adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: "test-secret" });

    expect(() => adapter.conversation(THREAD_ID)).toThrow(ValidationError);
    expect(() => adapter.conversation(null as never)).toThrow(ValidationError);
  });

  it("freezes the cohesive facade while leaving future operations side-effect free", async () => {
    const { adapter, chat, providerIO } = await createHarness();
    const conversation = adapter.conversation(chat.thread(THREAD_ID));

    expect(conversation.threadId).toBe(THREAD_ID);
    expect(Object.keys(conversation).sort()).toEqual([
      "addReaction",
      "group",
      "location",
      "removeReaction",
      "replyToPart",
      "sendVoiceMemo",
      "shareContactCard",
      "stopTyping",
      "threadId",
    ]);
    expect(Object.keys(conversation.group).sort()).toEqual([
      "addParticipant",
      "leave",
      "removeParticipant",
      "update",
    ]);
    expect(Object.keys(conversation.location).sort()).toEqual(["request", "retrieve"]);
    expect(Object.isFrozen(conversation)).toBe(true);
    expect(Object.isFrozen(conversation.group)).toBe(true);
    expect(Object.isFrozen(conversation.location)).toBe(true);

    const operations = [
      conversation.sendVoiceMemo({ url: "https://example.com/memo.m4a" }),
      conversation.group.update({ displayName: "Example" }),
      conversation.group.addParticipant("+15550000001"),
      conversation.group.removeParticipant("+15550000001"),
      conversation.group.leave(),
      conversation.location.request(),
      conversation.location.retrieve(),
    ];

    for (const operation of operations) {
      await expect(operation).rejects.toBeInstanceOf(NotImplementedError);
    }
    for (const providerCall of providerIO) expect(providerCall).not.toHaveBeenCalled();
  });

  it("translates part-reaction provider failures", async () => {
    const { adapter, addReaction } = await createHarness();
    addReaction.mockRejectedValueOnce(Object.assign(new Error("missing"), { status: 404 }));

    await expect(
      adapter.conversation(THREAD_ID).addReaction(MESSAGE_ID, "heart", { partIndex: 0 }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it.each([
    ["stopTyping", 400, ValidationError],
    ["stopTyping", 401, AuthenticationError],
    ["stopTyping", 403, PermissionError],
    ["stopTyping", 404, ResourceNotFoundError],
    ["stopTyping", 500, AdapterError],
    ["stopTyping", undefined, NetworkError],
    ["shareContactCard", 401, AuthenticationError],
    ["shareContactCard", 403, PermissionError],
    ["shareContactCard", 404, ResourceNotFoundError],
    ["shareContactCard", 500, AdapterError],
    ["shareContactCard", undefined, NetworkError],
  ] as const)(
    "translates %s provider failures with status %s",
    async (operation, status, ErrorType) => {
      const harness = await createHarness();
      const providerCall = harness[operation];
      const error = Object.assign(
        new Error("provider failure"),
        status === undefined ? {} : { status },
      );
      providerCall.mockRejectedValueOnce(error);

      await expect(harness.adapter.conversation(THREAD_ID)[operation]()).rejects.toBeInstanceOf(
        ErrorType,
      );
    },
  );
});

async function createHarness(): Promise<{
  adapter: LinqAdapter;
  addReaction: ReturnType<typeof vi.fn>;
  chat: Chat<{ linq: LinqAdapter }>;
  send: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  providerIO: ReturnType<typeof vi.fn>[];
  markAsRead: ReturnType<typeof vi.fn>;
  shareContactCard: ReturnType<typeof vi.fn>;
  startTyping: ReturnType<typeof vi.fn>;
  stopTyping: ReturnType<typeof vi.fn>;
}> {
  const adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: "test-secret" });
  const send = vi.fn().mockResolvedValue({
    chat_id: CHAT_ID,
    message: {
      created_at: "2026-08-20T00:00:00.000Z",
      delivery_status: "queued",
      id: MESSAGE_ID,
      is_read: false,
      parts: [],
      sent_at: null,
    },
  });
  const addReaction = vi.fn().mockResolvedValue({ message: "Reaction processed", status: "ok" });
  const update = vi.fn().mockResolvedValue({
    chat_id: CHAT_ID,
    created_at: "2026-08-20T00:00:00.000Z",
    delivery_status: "sent",
    id: MESSAGE_ID,
    is_read: false,
    parts: [{ type: "text", value: "updated", reactions: [] }],
    sent_at: "2026-08-20T00:00:00.000Z",
  });
  const list = vi.fn().mockResolvedValue({
    messages: [
      {
        chat_id: CHAT_ID,
        created_at: "2026-08-20T00:00:00.000Z",
        from_handle: {
          handle: "+15550000000",
          id: "44444444-4444-4444-4444-444444444444",
          is_me: true,
          joined_at: "2026-08-20T00:00:00.000Z",
          left_at: null,
          service: "iMessage",
          status: "active",
        },
        id: MESSAGE_ID,
        is_from_me: true,
        parts: [{ type: "text", value: "reply", reactions: [] }],
        sent_at: "2026-08-20T00:00:00.000Z",
      },
    ],
    next_cursor: null,
  });
  const stopTyping = vi.fn();
  const shareContactCard = vi.fn();
  const sendVoicememo = vi.fn();
  const updateChat = vi.fn();
  const addParticipant = vi.fn();
  const removeParticipant = vi.fn();
  const leaveChat = vi.fn();
  const requestLocation = vi.fn();
  const retrieveLocation = vi.fn();
  const startTyping = vi.fn();
  const markAsRead = vi.fn();
  const providerIO = [
    stopTyping,
    shareContactCard,
    sendVoicememo,
    updateChat,
    addParticipant,
    removeParticipant,
    leaveChat,
    requestLocation,
    retrieveLocation,
    startTyping,
    markAsRead,
  ];

  Object.assign(adapter.client, {
    chats: {
      leaveChat,
      location: { request: requestLocation, retrieve: retrieveLocation },
      messages: { list, send },
      participants: { add: addParticipant, remove: removeParticipant },
      sendVoicememo,
      shareContactCard,
      typing: { start: startTyping, stop: stopTyping },
      update: updateChat,
      markAsRead,
    },
    messages: { addReaction, update },
  });

  const state = {
    appendToList: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  } as unknown as StateAdapter;
  const chat = new Chat({
    adapters: { linq: adapter },
    logger: "silent",
    state,
    userName: "linq-conversation-test",
  });
  await chat.initialize();

  return {
    adapter,
    addReaction,
    chat,
    markAsRead,
    providerIO,
    send,
    shareContactCard,
    startTyping,
    stopTyping,
    update,
  };
}
