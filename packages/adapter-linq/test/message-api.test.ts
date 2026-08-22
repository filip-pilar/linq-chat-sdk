import {
  Actions,
  Button,
  Card,
  CardText,
  Chat,
  Message,
  paragraph,
  root,
  strong,
  text,
} from "chat";
import type { AdapterPostableMessage, RawMessage, StateAdapter } from "chat";
import { describe, expect, it, vi } from "vitest";

import {
  createLinqAdapter,
  linqMessage,
  type LinqAdapter,
  type LinqMessageOptions,
} from "../src/index.js";
import type { LinqRawMessage } from "../src/message-parser.js";

const THREAD_ID = "linq:chat-123";
const OPTIONS = {
  preferredService: "iMessage",
  effect: { type: "screen", name: "confetti" },
  decorations: [{ range: [0, 5], style: "bold" }],
  richLink: "https://example.com/preview",
} as const satisfies LinqMessageOptions;

describe("linqMessage", () => {
  it("creates an immutable metadata snapshot without mutating the content or options", () => {
    const effect = { type: "screen", name: "confetti" } as const;
    const range: [number, number] = [0, 5];
    const decorations = [{ range, style: "bold" as const }];
    const richLink = new URL("https://example.com/original");
    const options: LinqMessageOptions = {
      preferredService: "iMessage",
      effect,
      decorations,
      richLink,
    };
    const content: AdapterPostableMessage = { markdown: "**Hello**" };

    const message = linqMessage(content, options);

    expect(message).toEqual({
      markdown: "**Hello**",
      linq: {
        preferredService: "iMessage",
        effect,
        decorations,
        richLink: "https://example.com/original",
      },
    });
    expect(content).toEqual({ markdown: "**Hello**" });
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.linq)).toBe(true);
    expect(Object.isFrozen(message.linq.effect)).toBe(true);
    expect(Object.isFrozen(message.linq.decorations)).toBe(true);
    expect(Object.isFrozen(message.linq.decorations?.[0])).toBe(true);
    expect(Object.isFrozen(message.linq.decorations?.[0]?.range)).toBe(true);

    range[1] = 2;
    decorations.push({ range: [1, 2], style: "bold" });
    richLink.pathname = "/mutated";

    expect(message.linq.decorations).toEqual([{ range: [0, 5], style: "bold" }]);
    expect(message.linq.richLink).toBe("https://example.com/original");
    expect(() => Object.assign(message.linq, { preferredService: "SMS" })).toThrow();
  });

  it("turns strings into ordinary raw postables and remains JSON-serializable", () => {
    const message = linqMessage("hello", OPTIONS);

    expect(message).toEqual({ raw: "hello", linq: OPTIONS });
    expect(JSON.parse(JSON.stringify(message))).toEqual({ raw: "hello", linq: OPTIONS });
  });

  it("uses an empty immutable metadata object when options are omitted", () => {
    const message = linqMessage({ markdown: "hello" });

    expect(message).toEqual({ markdown: "hello", linq: {} });
    expect(Object.isFrozen(message.linq)).toBe(true);
  });
});

describe("linqMessage Chat SDK transport", () => {
  it("uses the ordinary Linq send path for implemented message options", async () => {
    const adapter = createLinqAdapter({
      apiKey: "test-key",
      signingSecret: "whsec_dGVzdC1zZWNyZXQ=",
    });
    const send = vi.spyOn(adapter.client.chats.messages, "send").mockResolvedValue({
      chat_id: "chat-123",
      message: {
        created_at: "2026-08-20T00:00:00.000Z",
        delivery_status: "queued",
        id: "provider-message",
        is_read: false,
        parts: [],
        sent_at: null,
      },
    });
    const state = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as StateAdapter;
    const chat = new Chat({
      adapters: { linq: adapter },
      logger: "silent",
      state,
      userName: "linq-message-api-test",
    });
    await chat.initialize();

    const sent = await chat.thread(THREAD_ID).post(
      linqMessage(
        {
          markdown: "**ordinary** send",
          attachments: [{ type: "image", url: "https://example.com/image.png" }],
        },
        {
          preferredService: OPTIONS.preferredService,
          effect: OPTIONS.effect,
          decorations: OPTIONS.decorations,
        },
      ),
    );

    expect(send).toHaveBeenCalledWith("chat-123", {
      message: {
        idempotency_key: expect.any(String),
        preferred_service: "iMessage",
        effect: { type: "screen", name: "confetti" },
        parts: [
          {
            type: "text",
            value: "ordinary send",
            text_decorations: [
              { range: [0, 5], style: "bold" },
              { range: [0, 8], style: "bold" },
            ],
          },
          { type: "media", url: "https://example.com/image.png" },
        ],
      },
    });
    expect(sent).toMatchObject({ id: "provider-message", threadId: THREAD_ID });
  });

  it.each([
    ["raw text", linqMessage("raw text", OPTIONS), "raw text"],
    ["markdown", linqMessage({ markdown: "**bold**" }, OPTIONS), "bold"],
    [
      "AST",
      linqMessage({ ast: root([paragraph([strong([text("bold AST")])])]) }, OPTIONS),
      "bold AST",
    ],
    ["card", linqMessage(Card({ children: [CardText("card text")] }), OPTIONS), "card text"],
    [
      "card wrapper",
      linqMessage(
        { card: Card({ children: [CardText("wrapped card")] }), fallbackText: "card fallback" },
        OPTIONS,
      ),
      "card fallback",
    ],
    [
      "attachments",
      linqMessage(
        {
          markdown: "attachment",
          attachments: [{ type: "image", url: "https://example.com/image.png", name: "image.png" }],
        },
        OPTIONS,
      ),
      "attachment",
    ],
    [
      "files",
      linqMessage(
        {
          markdown: "file",
          files: [{ data: Buffer.from("file"), filename: "file.txt", mimeType: "text/plain" }],
        },
        OPTIONS,
      ),
      "file",
    ],
  ] as const)(
    "preserves metadata and standard SentMessage behavior for %s",
    async (_name, message, textValue) => {
      const context = await createTransportContext();

      const sent = await context.thread.post(message);

      expect(context.postMessage).toHaveBeenCalledWith(
        THREAD_ID,
        expect.objectContaining({ linq: OPTIONS }),
      );
      expect(sent).toMatchObject({ id: "posted-message", threadId: THREAD_ID, text: textValue });
      expect(sent.formatted.type).toBe("root");
      expect(sent.toJSON()).toMatchObject({
        _type: "chat:Message",
        id: "posted-message",
        threadId: THREAD_ID,
        text: textValue,
      });
    },
  );

  it("retains metadata when Chat SDK rewrites card callback URLs", async () => {
    const context = await createTransportContext();
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

    await context.thread.post(linqMessage(card, OPTIONS));

    expect(context.state.set).toHaveBeenCalledWith(
      expect.stringMatching(/^chat:callback:/),
      { originalValue: "order-123", url: "https://example.com/callback" },
      30 * 24 * 60 * 60 * 1000,
    );
    const transported = context.postMessage.mock.calls[0]?.[1];
    expect(transported).toMatchObject({ linq: OPTIONS, type: "card" });
    expect(JSON.stringify(transported)).not.toContain("https://example.com/callback");
    expect(JSON.stringify(transported)).toContain("__cb:");
  });

  it("preserves metadata through replies and edits without changing canonical identity", async () => {
    const context = await createTransportContext();
    const original = await context.thread.post(linqMessage("original", OPTIONS));

    const reply = await context.thread.reply(
      "parent-message",
      linqMessage({ markdown: "reply" }, OPTIONS),
    );
    const edited = await original.edit(linqMessage({ markdown: "edited" }, OPTIONS));

    expect(context.reply).toHaveBeenCalledWith(
      THREAD_ID,
      "parent-message",
      expect.objectContaining({ markdown: "reply", linq: OPTIONS }),
    );
    expect(context.editMessage).toHaveBeenCalledWith(
      THREAD_ID,
      "posted-message",
      expect.objectContaining({ markdown: "edited", linq: OPTIONS }),
    );
    expect(reply).toMatchObject({ id: "reply-message", threadId: THREAD_ID, text: "reply" });
    expect(edited).toMatchObject({ id: "posted-message", threadId: THREAD_ID, text: "edited" });
  });

  it("leaves provider-backed history and Message serialization on standard Chat SDK contracts", async () => {
    const context = await createTransportContext();
    const historical = new Message<LinqRawMessage>({
      attachments: [],
      author: {
        fullName: "Linq user",
        isBot: false,
        isMe: false,
        userId: "user-123",
        userName: "+15550002000",
      },
      formatted: root([paragraph([text("history text")])]),
      id: "history-message",
      metadata: { dateSent: new Date("2026-08-20T00:00:00.000Z"), edited: false },
      raw: { id: "history-message" } as LinqRawMessage,
      text: "history text",
      threadId: THREAD_ID,
    });
    vi.spyOn(context.adapter, "fetchMessages").mockResolvedValue({ messages: [historical] });

    const messages = [];
    for await (const message of context.thread.messages) {
      messages.push(message);
    }

    expect(messages).toEqual([historical]);
    const serialized = messages[0]?.toJSON();
    expect(serialized).toMatchObject({
      _type: "chat:Message",
      id: "history-message",
      raw: { id: "history-message" },
      text: "history text",
      threadId: THREAD_ID,
    });
    expect(Message.fromJSON(serialized!).toJSON()).toEqual(serialized);
  });
});

async function createTransportContext(): Promise<{
  adapter: LinqAdapter;
  editMessage: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  state: StateAdapter;
  thread: ReturnType<Chat<{ linq: LinqAdapter }>["thread"]>;
}> {
  const adapter = createLinqAdapter({
    apiKey: "test-key",
    signingSecret: "whsec_dGVzdC1zZWNyZXQ=",
  });
  const postMessage = vi
    .spyOn(adapter, "postMessage")
    .mockResolvedValue(rawMessage("posted-message"));
  const reply = vi.spyOn(adapter, "reply").mockResolvedValue(rawMessage("reply-message"));
  const editMessage = vi
    .spyOn(adapter, "editMessage")
    .mockResolvedValue(rawMessage("posted-message"));
  const state = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  } as unknown as StateAdapter;
  const chat = new Chat({
    adapters: { linq: adapter },
    logger: "silent",
    state,
    userName: "linq-message-api-test",
  });
  await chat.initialize();

  return { adapter, editMessage, postMessage, reply, state, thread: chat.thread(THREAD_ID) };
}

function rawMessage(id: string): RawMessage<LinqRawMessage> {
  return {
    id,
    raw: { id } as LinqRawMessage,
    threadId: THREAD_ID,
  };
}
