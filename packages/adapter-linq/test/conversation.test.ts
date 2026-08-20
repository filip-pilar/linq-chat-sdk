import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import { Actions, Button, Card, Chat } from "chat";
import type { StateAdapter } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter, type LinqAdapter } from "../src/index.js";

const CHAT_ID = "11111111-1111-1111-1111-111111111111";
const GROUP_CHAT_ID = "55555555-5555-5555-5555-555555555555";
const THREAD_ID = `linq:${CHAT_ID}`;
const MESSAGE_ID = "22222222-2222-2222-2222-222222222222";
const PARENT_ID = "33333333-3333-3333-3333-333333333333";
const ATTACHMENT_ID = "66666666-6666-6666-6666-666666666666";

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

  it("updates supported group metadata with exact immutable request fields", async () => {
    const { adapter, chat, updateChat } = await createHarness();
    const threadId = adapter.encodeThreadId({ chatId: GROUP_CHAT_ID, isGroup: true });
    const iconUrl = new URL("https://media.example.com/group.png?version=1");
    const options = Object.freeze({ displayName: "Team Discussion", iconUrl });

    await expect(adapter.conversation(chat.thread(threadId)).group.update(options)).resolves.toBe(
      undefined,
    );

    expect(updateChat).toHaveBeenCalledWith(GROUP_CHAT_ID, {
      display_name: "Team Discussion",
      group_chat_icon: iconUrl.href,
    });
    expect(options).toEqual({ displayName: "Team Discussion", iconUrl });
  });

  it("preserves partial updates and repeated acknowledgements as repeated provider calls", async () => {
    const { adapter, updateChat } = await createHarness();
    const group = adapter.conversation(THREAD_ID).group;

    await group.update({ displayName: "First" });
    await group.update({ iconUrl: "https://media.example.com/icon.png" });
    await group.update({ displayName: "First" });

    expect(updateChat.mock.calls).toEqual([
      [CHAT_ID, { display_name: "First" }],
      [CHAT_ID, { group_chat_icon: "https://media.example.com/icon.png" }],
      [CHAT_ID, { display_name: "First" }],
    ]);
  });

  it("adds, removes, and leaves through the exact existing-group SDK operations", async () => {
    const { adapter, addParticipant, chat, leaveChat, removeParticipant } = await createHarness();
    const threadId = adapter.encodeThreadId({ chatId: GROUP_CHAT_ID, isGroup: true });
    const group = adapter.conversation(chat.thread(threadId)).group;

    await group.addParticipant("+15550000001");
    await group.addParticipant("member@example.com");
    await group.removeParticipant("+15550000002");
    await group.removeParticipant("former@example.com");
    await group.leave();
    await group.leave();

    expect(addParticipant.mock.calls).toEqual([
      [GROUP_CHAT_ID, { handle: "+15550000001" }],
      [GROUP_CHAT_ID, { handle: "member@example.com" }],
    ]);
    expect(removeParticipant.mock.calls).toEqual([
      [GROUP_CHAT_ID, { handle: "+15550000002" }],
      [GROUP_CHAT_ID, { handle: "former@example.com" }],
    ]);
    expect(leaveChat.mock.calls).toEqual([[GROUP_CHAT_ID], [GROUP_CHAT_ID]]);
  });

  it("coexists with ordinary Chat SDK group posting without changing its transport", async () => {
    const { adapter, chat, send, updateChat } = await createHarness();
    const threadId = adapter.encodeThreadId({ chatId: GROUP_CHAT_ID, isGroup: true });
    const thread = chat.thread(threadId);

    await adapter.conversation(thread).group.update({ displayName: "Group" });
    await thread.post("ordinary group message");

    expect(updateChat).toHaveBeenCalledWith(GROUP_CHAT_ID, { display_name: "Group" });
    expect(send).toHaveBeenCalledWith(
      GROUP_CHAT_ID,
      expect.objectContaining({
        message: expect.objectContaining({
          parts: [{ type: "text", value: "ordinary group message" }],
        }),
      }),
    );
  });

  it.each([
    undefined,
    null,
    {},
    { displayName: undefined },
    { iconUrl: undefined },
    { displayName: 42 },
    { iconUrl: 42 },
    { iconUrl: "" },
    { iconUrl: " https://media.example.com/icon.png" },
    { iconUrl: "http://media.example.com/icon.png" },
    { iconUrl: "not a URL" },
    { iconUrl: new URL("http://media.example.com/icon.png") },
    { display_name: "endpoint-shaped" },
    { displayName: "Group", unsupported: true },
  ])("rejects invalid group update %j before provider work", async (options) => {
    const { adapter, providerIO } = await createHarness();

    await expect(
      (adapter.conversation(THREAD_ID).group.update as (value: unknown) => Promise<void>)(options),
    ).rejects.toBeInstanceOf(ValidationError);
    for (const providerCall of providerIO) expect(providerCall).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    "",
    " +15550000001",
    "+0123456789",
    "+1555-000-0001",
    "+1234567890123456",
    "not-a-handle",
    "member@localhost",
    "member@@example.com",
    "SMS:+15550000001",
    42,
  ])("rejects invalid participant handle %j before provider work", async (handle) => {
    const { adapter, providerIO } = await createHarness();
    const group = adapter.conversation(THREAD_ID).group;

    await expect(
      (group.addParticipant as (value: unknown) => Promise<void>)(handle),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      (group.removeParticipant as (value: unknown) => Promise<void>)(handle),
    ).rejects.toBeInstanceOf(ValidationError);
    for (const providerCall of providerIO) expect(providerCall).not.toHaveBeenCalled();
  });

  it("rejects every group operation locally for a known direct chat", async () => {
    const { adapter, providerIO } = await createHarness();
    const directThreadId = adapter.encodeThreadId({ chatId: CHAT_ID, isGroup: false });
    const group = adapter.conversation(directThreadId).group;

    const operations = [
      group.update({ displayName: "Not a group" }),
      group.addParticipant("+15550000001"),
      group.removeParticipant("+15550000001"),
      group.leave(),
    ];
    for (const operation of operations) {
      await expect(operation).rejects.toBeInstanceOf(ValidationError);
    }
    for (const providerCall of providerIO) expect(providerCall).not.toHaveBeenCalled();
  });

  it("does not probe classification for an opaque owned canonical string ID", async () => {
    const { adapter, retrieveChat, updateChat } = await createHarness();

    await adapter.conversation(THREAD_ID).group.update({ displayName: "Opaque group" });

    expect(updateChat).toHaveBeenCalledWith(CHAT_ID, { display_name: "Opaque group" });
    expect(retrieveChat).not.toHaveBeenCalled();
  });

  it("requests location as an acknowledgement for known direct and opaque chats", async () => {
    const { adapter, chat, requestLocation, retrieveChat } = await createHarness();
    const directThreadId = adapter.encodeThreadId({ chatId: CHAT_ID, isGroup: false });

    await expect(
      adapter.conversation(chat.thread(directThreadId)).location.request(),
    ).resolves.toBe(undefined);
    await expect(adapter.conversation(THREAD_ID).location.request()).resolves.toBe(undefined);

    expect(requestLocation.mock.calls).toEqual([[CHAT_ID], [CHAT_ID]]);
    expect(retrieveChat).not.toHaveBeenCalled();
  });

  it("rejects a location request for a known group before provider work", async () => {
    const { adapter, providerIO } = await createHarness();
    const groupThreadId = adapter.encodeThreadId({ chatId: GROUP_CHAT_ID, isGroup: true });

    await expect(adapter.conversation(groupThreadId).location.request()).rejects.toBeInstanceOf(
      ValidationError,
    );
    for (const providerCall of providerIO) expect(providerCall).not.toHaveBeenCalled();
  });

  it("retrieves a frozen ordered location snapshot from direct or group chats", async () => {
    const { adapter, chat, retrieveLocation } = await createHarness();
    const groupThreadId = adapter.encodeThreadId({ chatId: GROUP_CHAT_ID, isGroup: true });
    retrieveLocation.mockResolvedValueOnce({
      success: true,
      data: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-122.4194, 37.7749] },
            properties: {
              handle: "+15550000001",
              address: "1 Market Street",
              locality: "San Francisco",
              updated_at: "2026-08-20T10:20:30.000Z",
            },
          },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [55.2708, 25.2048, 8.5] },
            properties: { handle: "member@example.com" },
          },
        ],
      },
    });

    const snapshot = await adapter.conversation(chat.thread(groupThreadId)).location.retrieve();

    expect(retrieveLocation).toHaveBeenCalledWith(GROUP_CHAT_ID);
    expect(snapshot).toEqual({
      threadId: groupThreadId,
      locations: [
        {
          handle: "+15550000001",
          longitude: -122.4194,
          latitude: 37.7749,
          address: "1 Market Street",
          locality: "San Francisco",
          updatedAt: "2026-08-20T10:20:30.000Z",
        },
        { handle: "member@example.com", longitude: 55.2708, latitude: 25.2048, altitude: 8.5 },
      ],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.locations)).toBe(true);
    expect(snapshot.locations.every(Object.isFrozen)).toBe(true);
  });

  it("isolates malformed GeoJSON rows while preserving valid sibling order and raw timestamps", async () => {
    const { adapter, retrieveLocation } = await createHarness();
    retrieveLocation.mockResolvedValueOnce({
      success: true,
      data: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: null, properties: { handle: "bad" } },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [151.2093, -33.8688, "unknown"] },
            properties: {
              handle: "first@example.com",
              updated_at: "not-a-date",
              address: 42,
            },
          },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [181, 20] },
            properties: { handle: "outside@example.com" },
          },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-0.1276, 51.5072] },
            properties: { handle: "+442071234567", updated_at: "2026-08-20T10:20:30+04:00" },
          },
        ],
      },
    });

    const snapshot = await adapter.conversation(THREAD_ID).location.retrieve();

    expect(snapshot.locations).toEqual([
      { handle: "first@example.com", longitude: 151.2093, latitude: -33.8688 },
      {
        handle: "+442071234567",
        longitude: -0.1276,
        latitude: 51.5072,
        updatedAt: "2026-08-20T10:20:30+04:00",
      },
    ]);
  });

  it.each([
    undefined,
    null,
    {},
    { data: null },
    { success: false, data: { type: "FeatureCollection", features: [] } },
    { data: { type: "FeatureCollection", features: null } },
    {
      data: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: { type: "Point", coordinates: [10] } }],
      },
    },
  ])(
    "returns an immutable empty snapshot when response %j has no usable rows",
    async (response) => {
      const { adapter, retrieveLocation } = await createHarness();
      retrieveLocation.mockResolvedValueOnce(response);

      const snapshot = await adapter.conversation(THREAD_ID).location.retrieve();

      expect(snapshot).toEqual({ threadId: THREAD_ID, locations: [] });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.locations)).toBe(true);
    },
  );

  it("sends a voice memo from a public HTTPS URL and returns frozen canonical identity", async () => {
    const { adapter, chat, sendVoicememo } = await createHarness();
    const source = Object.freeze({ url: "https://media.example.com/memo.m4a" });

    const result = await adapter.conversation(chat.thread(THREAD_ID)).sendVoiceMemo(source);

    expect(sendVoicememo).toHaveBeenCalledWith(CHAT_ID, {
      voice_memo_url: "https://media.example.com/memo.m4a",
    });
    expect(result).toEqual({
      messageId: MESSAGE_ID,
      threadId: THREAD_ID,
      attachmentId: ATTACHMENT_ID,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(source).toEqual({ url: "https://media.example.com/memo.m4a" });
  });

  it("sends a voice memo from an existing attachment ID without mutating the source", async () => {
    const { adapter, sendVoicememo } = await createHarness();
    const source = Object.freeze({ attachmentId: ATTACHMENT_ID });

    const result = await adapter.conversation(THREAD_ID).sendVoiceMemo(source);

    expect(sendVoicememo).toHaveBeenCalledWith(CHAT_ID, { attachment_id: ATTACHMENT_ID });
    expect(result.threadId).toBe(THREAD_ID);
    expect(source).toEqual({ attachmentId: ATTACHMENT_ID });
  });

  it("accepts a URL object by snapshotting its HTTPS href", async () => {
    const { adapter, sendVoicememo } = await createHarness();
    const url = new URL("https://media.example.com/memo.m4a?version=1");

    await adapter.conversation(THREAD_ID).sendVoiceMemo({ url });

    expect(sendVoicememo).toHaveBeenCalledWith(CHAT_ID, { voice_memo_url: url.href });
  });

  it.each([
    undefined,
    null,
    {},
    { url: "https://media.example.com/memo.m4a", attachmentId: ATTACHMENT_ID },
    { url: "" },
    { url: " https://media.example.com/memo.m4a" },
    { url: "http://media.example.com/memo.m4a" },
    { url: "ftp://media.example.com/memo.m4a" },
    { url: "not a URL" },
    { url: new URL("http://media.example.com/memo.m4a") },
    { url: 42 },
    { attachmentId: "" },
    { attachmentId: ` ${ATTACHMENT_ID}` },
    { attachmentId: "not-a-uuid" },
    { attachmentId: 42 },
  ])("rejects invalid voice memo source %j before provider work", async (source) => {
    const { adapter, providerIO } = await createHarness();

    await expect(
      (adapter.conversation(THREAD_ID).sendVoiceMemo as (value: unknown) => Promise<unknown>)(
        source,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    for (const providerCall of providerIO) expect(providerCall).not.toHaveBeenCalled();
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

  it("freezes the cohesive facade and its nested surfaces", async () => {
    const { adapter, chat } = await createHarness();
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

  it.each(["requestLocation", "retrieveLocation"] as const)(
    "translates %s provider failures",
    async (operation) => {
      for (const [status, ErrorType] of [
        [400, ValidationError],
        [401, AuthenticationError],
        [403, PermissionError],
        [404, ResourceNotFoundError],
        [409, AdapterError],
        [429, AdapterRateLimitError],
        [500, AdapterError],
        [undefined, NetworkError],
      ] as const) {
        const harness = await createHarness();
        harness[operation].mockRejectedValueOnce(
          Object.assign(new Error("provider failure"), status === undefined ? {} : { status }),
        );

        const call =
          operation === "requestLocation"
            ? harness.adapter.conversation(THREAD_ID).location.request()
            : harness.adapter.conversation(THREAD_ID).location.retrieve();
        await expect(call).rejects.toBeInstanceOf(ErrorType);
      }
    },
  );

  it.each(["updateChat", "addParticipant", "removeParticipant", "leaveChat"] as const)(
    "translates %s group provider failures",
    async (operation) => {
      for (const [status, ErrorType] of [
        [400, ValidationError],
        [401, AuthenticationError],
        [403, PermissionError],
        [404, ResourceNotFoundError],
        [409, AdapterError],
        [429, AdapterRateLimitError],
        [500, AdapterError],
        [undefined, NetworkError],
      ] as const) {
        const harness = await createHarness();
        const providerCall = harness[operation];
        providerCall.mockRejectedValueOnce(
          Object.assign(new Error("provider failure"), status === undefined ? {} : { status }),
        );
        const group = harness.adapter.conversation(THREAD_ID).group;
        const request =
          operation === "updateChat"
            ? group.update({ displayName: "Group" })
            : operation === "addParticipant"
              ? group.addParticipant("+15550000001")
              : operation === "removeParticipant"
                ? group.removeParticipant("+15550000001")
                : group.leave();

        await expect(request).rejects.toBeInstanceOf(ErrorType);
      }
    },
  );

  it.each([
    [400, ValidationError],
    [401, AuthenticationError],
    [403, PermissionError],
    [404, ResourceNotFoundError],
    [413, AdapterError],
    [422, ValidationError],
    [500, AdapterError],
    [undefined, NetworkError],
  ] as const)(
    "translates voice memo provider failures with status %s",
    async (status, ErrorType) => {
      const { adapter, sendVoicememo } = await createHarness();
      const error = Object.assign(
        new Error("provider failure"),
        status === undefined ? {} : { status },
      );
      sendVoicememo.mockRejectedValueOnce(error);

      await expect(
        adapter.conversation(THREAD_ID).sendVoiceMemo({ attachmentId: ATTACHMENT_ID }),
      ).rejects.toBeInstanceOf(ErrorType);
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
  sendVoicememo: ReturnType<typeof vi.fn>;
  startTyping: ReturnType<typeof vi.fn>;
  stopTyping: ReturnType<typeof vi.fn>;
  updateChat: ReturnType<typeof vi.fn>;
  addParticipant: ReturnType<typeof vi.fn>;
  removeParticipant: ReturnType<typeof vi.fn>;
  leaveChat: ReturnType<typeof vi.fn>;
  retrieveChat: ReturnType<typeof vi.fn>;
  requestLocation: ReturnType<typeof vi.fn>;
  retrieveLocation: ReturnType<typeof vi.fn>;
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
  const sendVoicememo = vi.fn().mockResolvedValue({
    voice_memo: {
      id: MESSAGE_ID,
      chat: { id: CHAT_ID, is_group: false },
      voice_memo: { id: ATTACHMENT_ID },
    },
  });
  const updateChat = vi.fn();
  const addParticipant = vi.fn();
  const removeParticipant = vi.fn();
  const leaveChat = vi.fn();
  const requestLocation = vi.fn().mockResolvedValue({ success: true, message: "Requested" });
  const retrieveLocation = vi.fn().mockResolvedValue({
    success: true,
    data: { type: "FeatureCollection", features: [] },
  });
  const startTyping = vi.fn();
  const markAsRead = vi.fn();
  const retrieveChat = vi.fn();
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
    retrieveChat,
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
      retrieve: retrieveChat,
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
    addParticipant,
    chat,
    markAsRead,
    leaveChat,
    providerIO,
    removeParticipant,
    requestLocation,
    retrieveLocation,
    retrieveChat,
    send,
    sendVoicememo,
    shareContactCard,
    startTyping,
    stopTyping,
    updateChat,
    update,
  };
}
