import { ValidationError } from "@chat-adapter/shared";
import { Actions, Button, Card } from "chat";
import type { AdapterPostableMessage } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter, linqMessage } from "../src/index.js";
import { compileLinqSendOptions } from "../src/message-compiler.js";

const SCREEN_EFFECTS = [
  "confetti",
  "fireworks",
  "lasers",
  "sparkles",
  "celebration",
  "hearts",
  "love",
  "balloons",
  "happy_birthday",
  "echo",
  "spotlight",
] as const;
const BUBBLE_EFFECTS = ["slam", "loud", "gentle", "invisible"] as const;

describe("compileLinqSendOptions", () => {
  it.each([undefined, "iMessage", "RCS", "SMS"] as const)(
    "preserves the %s preferred-service selection",
    (preferredService) => {
      const message = linqMessage("hello", preferredService ? { preferredService } : {});

      expect(compileLinqSendOptions(message)).toEqual(preferredService ? { preferredService } : {});
    },
  );

  it.each(SCREEN_EFFECTS)("accepts the %s screen effect", (name) => {
    expect(
      compileLinqSendOptions(linqMessage("hello", { effect: { type: "screen", name } })),
    ).toEqual({ effect: { type: "screen", name } });
  });

  it.each(BUBBLE_EFFECTS)("accepts the %s bubble effect", (name) => {
    expect(
      compileLinqSendOptions(linqMessage("hello", { effect: { type: "bubble", name } })),
    ).toEqual({ effect: { type: "bubble", name } });
  });

  it("allows omitted service and explicit iMessage with Linq-only enhancements", () => {
    const enhancements = {
      effect: { type: "screen", name: "confetti" },
      decorations: [
        { range: [0, 2], style: "underline" },
        { range: [2, 5], animation: "shake" },
      ],
    } as const;

    expect(compileLinqSendOptions(linqMessage("hello", enhancements))).toEqual({
      effect: enhancements.effect,
    });
    expect(
      compileLinqSendOptions(
        linqMessage("hello", { preferredService: "iMessage", ...enhancements }),
      ),
    ).toEqual({ preferredService: "iMessage", effect: enhancements.effect });
  });

  it.each([
    ["auto service", { preferredService: "auto" }],
    ["lowercase service", { preferredService: "sms" }],
    ["null service", { preferredService: null }],
    ["non-object options", null],
    ["null effect", { effect: null }],
    ["unknown effect type", { effect: { type: "full", name: "confetti" } }],
    ["missing effect name", { effect: { type: "screen" } }],
    ["unknown screen effect", { effect: { type: "screen", name: "spin" } }],
    ["bubble name on screen", { effect: { type: "screen", name: "slam" } }],
    ["screen name on bubble", { effect: { type: "bubble", name: "confetti" } }],
  ])("rejects hostile %s input", (_name, linq) => {
    const message = { raw: "hello", linq } as AdapterPostableMessage;
    expect(() => compileLinqSendOptions(message)).toThrow(ValidationError);
  });
});

describe("Linq preferred-service and effect transport", () => {
  it.each(["RCS", "SMS"] as const)(
    "sends standard derived formatting through explicit %s without Linq-only intent",
    async (preferredService) => {
      const { adapter, send } = createAdapterHarness();

      await adapter.postMessage(
        "linq:chat-123",
        linqMessage({ markdown: "**Hello**" }, { preferredService }),
      );

      expect(send).toHaveBeenCalledWith("chat-123", {
        message: {
          idempotency_key: expect.any(String),
          parts: [
            {
              type: "text",
              value: "Hello",
              text_decorations: [{ range: [0, 5], style: "bold" }],
            },
          ],
          preferred_service: preferredService,
        },
      });
    },
  );

  it("omits service selection while sending best-effort effect and decorations", async () => {
    const { adapter, send } = createAdapterHarness();
    const message = linqMessage("hello", {
      effect: { type: "bubble", name: "loud" },
      decorations: [{ range: [0, 5], style: "underline" }],
    });

    await adapter.postMessage("linq:chat-123", message);

    expect(send).toHaveBeenCalledWith("chat-123", {
      message: {
        idempotency_key: expect.any(String),
        parts: [
          {
            type: "text",
            value: "hello",
            text_decorations: [{ range: [0, 5], style: "underline" }],
          },
        ],
        effect: { type: "bubble", name: "loud" },
      },
    });
    expect(message.linq).toEqual({
      effect: { type: "bubble", name: "loud" },
      decorations: [{ range: [0, 5], style: "underline" }],
    });
    expect(Object.isFrozen(message.linq.effect)).toBe(true);
  });

  it("places iMessage, effect, media, and reply fields inside the canonical message body", async () => {
    const { adapter, send } = createAdapterHarness();
    const message = linqMessage(
      {
        raw: "hello",
        attachments: [{ type: "image", url: "https://example.com/image.png" }],
      },
      { preferredService: "iMessage", effect: { type: "screen", name: "fireworks" } },
    );

    await adapter.reply("linq:chat-123", "parent-message", message);

    expect(send).toHaveBeenCalledWith("chat-123", {
      message: {
        idempotency_key: expect.any(String),
        parts: [
          { type: "text", value: "hello" },
          { type: "media", url: "https://example.com/image.png" },
        ],
        preferred_service: "iMessage",
        effect: { type: "screen", name: "fireworks" },
        reply_to: { message_id: "parent-message" },
      },
    });
  });

  it.each([
    ["screen effect", { effect: { type: "screen", name: "confetti" } }],
    ["bubble effect", { effect: { type: "bubble", name: "slam" } }],
    ["manual style", { decorations: [{ range: [0, 5], style: "underline" }] }],
    ["manual animation", { decorations: [{ range: [0, 5], animation: "shake" }] }],
  ] as const)(
    "rejects explicit RCS/SMS with %s before provider or attachment work",
    async (_name, intent) => {
      for (const preferredService of ["RCS", "SMS"] as const) {
        const { adapter, createAttachment, send } = createAdapterHarness();
        const message = linqMessage(
          {
            raw: "hello",
            files: [{ data: Buffer.from("file"), filename: "file.txt", mimeType: "text/plain" }],
          },
          { preferredService, ...intent },
        );

        await expect(adapter.postMessage("linq:chat-123", message)).rejects.toBeInstanceOf(
          ValidationError,
        );
        expect(createAttachment).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects contradictory card intent before interactive-card logging", async () => {
    const { adapter, send, warn } = createAdapterHarness();
    const message = linqMessage(
      Card({ children: [Actions([Button({ id: "yes", label: "Yes" })])] }),
      { preferredService: "RCS", effect: { type: "screen", name: "confetti" } },
    );

    await expect(adapter.postMessage("linq:chat-123", message)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(warn).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown service", { preferredService: "auto" }],
    ["mismatched effect", { effect: { type: "screen", name: "slam" } }],
  ])("rejects hostile %s before provider or attachment work", async (_name, linq) => {
    const { adapter, createAttachment, send } = createAdapterHarness();
    const message = {
      raw: "hello",
      files: [{ data: Buffer.from("file"), filename: "file.txt", mimeType: "text/plain" }],
      linq,
    } as AdapterPostableMessage;

    await expect(adapter.postMessage("linq:chat-123", message)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(createAttachment).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

function createAdapterHarness() {
  const adapter = createLinqAdapter({
    apiKey: "test-key",
    signingSecret: "whsec_dGVzdC1zZWNyZXQ=",
  });
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
    chats: { messages: { send } },
    attachments: { create: createAttachment },
  });
  Object.assign(adapter, { logger: { warn } });

  return { adapter, createAttachment, send, warn };
}
