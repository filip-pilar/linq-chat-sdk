import { ValidationError } from "@chat-adapter/shared";
import { Actions, Button, Card, CardText, Chat, Image } from "chat";
import type { AdapterPostableMessage, StateAdapter } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter, linqMessage } from "../src/index.js";

describe("Linq rich-link transport", () => {
  it.each([undefined, "iMessage", "RCS", "SMS"] as const)(
    "sends one native link part with %s service intent",
    async (preferredService) => {
      const { adapter, send } = createHarness();

      await adapter.postMessage(
        "linq:chat-123",
        linqMessage("", {
          richLink: new URL("https://example.com/preview"),
          ...(preferredService === undefined ? {} : { preferredService }),
        }),
      );

      expect(send).toHaveBeenCalledWith("chat-123", {
        message: {
          idempotency_key: expect.any(String),
          parts: [{ type: "link", value: "https://example.com/preview" }],
          ...(preferredService === undefined ? {} : { preferred_service: preferredService }),
        },
      });
    },
  );

  it("allows the documented 2048-character HTTPS boundary", async () => {
    const { adapter, send } = createHarness();
    const prefix = "https://example.com/";
    const richLink = prefix + "a".repeat(2_048 - prefix.length);

    await adapter.postMessage("linq:chat-123", linqMessage("", { richLink }));

    expect(send.mock.calls[0]?.[1].message.parts).toEqual([{ type: "link", value: richLink }]);
  });

  it.each([
    ["empty", ""],
    ["relative", "/preview"],
    ["HTTP", "http://example.com/preview"],
    ["missing host", "https://"],
    ["surrounding whitespace", " https://example.com/preview "],
    ["too long", `https://example.com/${"a".repeat(2_048)}`],
    ["non-string", 42],
  ])("rejects %s rich links before side effects", async (_name, richLink) => {
    const { adapter, createAttachment, send, warn } = createHarness();
    const message = {
      raw: "",
      linq: { richLink },
    } as unknown as AdapterPostableMessage;

    await expect(adapter.postMessage("linq:chat-123", message)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(createAttachment).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["raw text", "hello"],
    ["markdown", { markdown: "**hello**" }],
    [
      "attachment",
      { raw: "", attachments: [{ type: "image", url: "https://example.com/image.png" }] },
    ],
    [
      "file",
      {
        raw: "",
        files: [{ data: Buffer.from("file"), filename: "file.txt", mimeType: "text/plain" }],
      },
    ],
    ["card text", Card({ children: [CardText("hello")] })],
    ["card image", Card({ children: [Image({ url: "https://example.com/image.png" })] })],
  ] as const)("rejects rich-link coexistence with %s", async (_name, content) => {
    const { adapter, createAttachment, send } = createHarness();

    await expect(
      adapter.postMessage(
        "linq:chat-123",
        linqMessage(content as AdapterPostableMessage, { richLink: "https://example.com/preview" }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(createAttachment).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects interactive card coexistence before logging", async () => {
    const { adapter, send, warn } = createHarness();
    const card = Card({
      children: [Actions([Button({ id: "approve", label: "Approve" })])],
    });

    await expect(
      adapter.postMessage(
        "linq:chat-123",
        linqMessage(card, { richLink: "https://example.com/preview" }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(warn).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps an ordinary URL in content on the standard text path", async () => {
    const { adapter, send } = createHarness();

    await adapter.postMessage("linq:chat-123", "See https://example.com/preview");

    expect(send.mock.calls[0]?.[1].message.parts).toEqual([
      { type: "text", value: "See https://example.com/preview" },
    ]);
  });

  it("preserves native link parts through ordinary Chat SDK post and reply behavior", async () => {
    const { adapter, send } = createHarness();
    const state = {
      appendToList: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as StateAdapter;
    const chat = new Chat({
      adapters: { linq: adapter },
      logger: "silent",
      state,
      userName: "linq-rich-link-test",
    });
    await chat.initialize();
    const thread = chat.thread("linq:chat-123");

    const posted = await thread.post(linqMessage("", { richLink: "https://example.com/posted" }));
    const replied = await thread.reply(
      "parent-message",
      linqMessage("", { richLink: "https://example.com/replied" }),
    );

    expect(send.mock.calls[0]?.[1].message.parts).toEqual([
      { type: "link", value: "https://example.com/posted" },
    ]);
    expect(send.mock.calls[1]?.[1].message).toMatchObject({
      parts: [{ type: "link", value: "https://example.com/replied" }],
      reply_to: { message_id: "parent-message" },
    });
    expect(posted).toMatchObject({ id: "sent-message", threadId: "linq:chat-123" });
    expect(replied).toMatchObject({ id: "sent-message", threadId: "linq:chat-123" });
  });
});

function createHarness() {
  const adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: "test-secret" });
  const send = vi.fn().mockResolvedValue({
    chat_id: "chat-123",
    message: {
      created_at: "2026-08-20T00:00:00.000Z",
      delivery_status: "queued",
      id: "sent-message",
      is_read: false,
      parts: [],
      sent_at: null,
    },
  });
  const createAttachment = vi.fn();
  const warn = vi.fn();

  Object.assign(adapter.client, {
    attachments: { create: createAttachment },
    chats: { messages: { send } },
  });
  Object.assign(adapter, { logger: { warn } });

  return { adapter, createAttachment, send, warn };
}
