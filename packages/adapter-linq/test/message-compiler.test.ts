import { ValidationError } from "@chat-adapter/shared";
import { Card, CardText, paragraph, root, strikethrough, strong, text } from "chat";
import type { AdapterPostableMessage } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter, linqMessage } from "../src/index.js";
import { compileLinqMessageText } from "../src/message-compiler.js";

describe("compileLinqMessageText", () => {
  it("renders raw, Markdown, AST, links, newlines, and static card text deterministically", () => {
    expect(compileLinqMessageText("  raw text  ")).toEqual({
      text: "raw text",
      decorations: [],
    });
    expect(compileLinqMessageText({ markdown: "" })).toEqual({ text: "", decorations: [] });
    expect(
      compileLinqMessageText({
        markdown: "[**bold link**](https://example.com)\n\nnext",
      }),
    ).toEqual({
      text: "bold link\n\nnext",
      decorations: [{ range: [0, 9], style: "bold" }],
    });
    expect(
      compileLinqMessageText({
        ast: root([paragraph([strikethrough([text("gone")])]), paragraph([text("next")])]),
      }),
    ).toEqual({
      text: "gone\n\nnext",
      decorations: [{ range: [0, 4], style: "strikethrough" }],
    });
    expect(compileLinqMessageText({ ast: root([paragraph([strong([text(" bold ")])])]) })).toEqual({
      text: "bold",
      decorations: [{ range: [0, 4], style: "bold" }],
    });
    expect(
      compileLinqMessageText(
        Card({
          title: "Status",
          children: [CardText("**Ready** and _waiting_")],
        }),
      ),
    ).toEqual({
      text: "Status\nReady and waiting",
      decorations: [
        { range: [7, 12], style: "bold" },
        { range: [17, 24], style: "italic" },
      ],
    });
  });

  it("uses UTF-16 code-unit offsets without normalizing emoji or combining characters", () => {
    expect(
      compileLinqMessageText(
        linqMessage("😀e\u0301!", {
          decorations: [
            { range: [0, 2], style: "bold" },
            { range: [2, 4], style: "underline" },
          ],
        }),
      ),
    ).toEqual({
      text: "😀e\u0301!",
      decorations: [
        { range: [0, 2], style: "bold" },
        { range: [2, 4], style: "underline" },
      ],
    });
  });

  it("interprets manual ranges against final trimmed text without mutating the metadata snapshot", () => {
    const message = linqMessage("  hi 😀  ", {
      decorations: [{ range: [3, 5], style: "underline" }],
    });

    expect(compileLinqMessageText(message)).toEqual({
      text: "hi 😀",
      decorations: [{ range: [3, 5], style: "underline" }],
    });
    expect(message).toEqual({
      raw: "  hi 😀  ",
      linq: { decorations: [{ range: [3, 5], style: "underline" }] },
    });
    expect(Object.isFrozen(message.linq.decorations?.[0]?.range)).toBe(true);
  });

  it("keeps nested and partially overlapping styles, deduplicates exact matches, and sorts output", () => {
    const message = linqMessage(
      { markdown: "**A _B_ C**" },
      {
        decorations: [
          { range: [2, 5], style: "underline" },
          { range: [0, 5], style: "bold" },
          { range: [1, 4], style: "strikethrough" },
          { range: [2, 3], style: "italic" },
        ],
      },
    );

    expect(compileLinqMessageText(message)).toEqual({
      text: "A B C",
      decorations: [
        { range: [0, 5], style: "bold" },
        { range: [1, 4], style: "strikethrough" },
        { range: [2, 3], style: "italic" },
        { range: [2, 5], style: "underline" },
      ],
    });
  });

  it("allows adjacent animations but rejects animation overlap with any decoration", () => {
    expect(
      compileLinqMessageText(
        linqMessage("abcd", {
          decorations: [
            { range: [0, 2], animation: "shake" },
            { range: [0, 2], animation: "shake" },
            { range: [2, 4], animation: "bloom" },
          ],
        }),
      ).decorations,
    ).toEqual([
      { range: [0, 2], animation: "shake" },
      { range: [2, 4], animation: "bloom" },
    ]);

    expect(() =>
      compileLinqMessageText(
        linqMessage(
          { markdown: "**abcd**" },
          { decorations: [{ range: [1, 3], animation: "shake" }] },
        ),
      ),
    ).toThrow("animation ranges cannot overlap");
    expect(() =>
      compileLinqMessageText(
        linqMessage("abcd", {
          decorations: [
            { range: [0, 3], animation: "shake" },
            { range: [2, 4], animation: "bloom" },
          ],
        }),
      ),
    ).toThrow("animation ranges cannot overlap");
  });

  it.each([
    ["missing range", { style: "bold" }],
    ["short range", { range: [0], style: "bold" }],
    ["fractional range", { range: [0, 1.5], style: "bold" }],
    ["negative range", { range: [-1, 1], style: "bold" }],
    ["zero-length range", { range: [1, 1], style: "bold" }],
    ["reversed range", { range: [2, 1], style: "bold" }],
    ["out-of-bounds range", { range: [0, 5], style: "bold" }],
    ["missing kind", { range: [0, 1] }],
    ["contradictory kinds", { range: [0, 1], style: "bold", animation: "shake" }],
    ["unknown style", { range: [0, 1], style: "sparkly" }],
    ["unknown animation", { range: [0, 1], animation: "spin" }],
  ])("rejects %s", (_name, decoration) => {
    const message = { raw: "abcd", linq: { decorations: [decoration] } } as AdapterPostableMessage;
    expect(() => compileLinqMessageText(message)).toThrow(ValidationError);
  });

  it("rejects decorations on empty text", () => {
    const message = {
      raw: "",
      linq: { decorations: [{ range: [0, 1], style: "bold" }] },
    } as AdapterPostableMessage;
    expect(() => compileLinqMessageText(message)).toThrow(ValidationError);
  });
});

describe("Linq decoration transport", () => {
  it("sends compiled Markdown plus manual decorations through post and reply", async () => {
    const { adapter, send } = createAdapterHarness();
    const message = linqMessage(
      { markdown: "**Hello** 😀" },
      { decorations: [{ range: [6, 8], animation: "shake" }] },
    );

    await adapter.postMessage("linq:chat-123", message);
    await adapter.reply("linq:chat-123", "parent", message);

    const part = {
      type: "text",
      value: "Hello 😀",
      text_decorations: [
        { range: [0, 5], style: "bold" },
        { range: [6, 8], animation: "shake" },
      ],
    };
    expect(send).toHaveBeenNthCalledWith(1, "chat-123", {
      message: { idempotency_key: expect.any(String), parts: [part] },
    });
    expect(send).toHaveBeenNthCalledWith(2, "chat-123", {
      message: {
        idempotency_key: expect.any(String),
        parts: [part],
        reply_to: { message_id: "parent" },
      },
    });
  });

  it("compiles edit text while retaining the SDK's text-only edit contract", async () => {
    const { adapter, update } = createAdapterHarness();

    await adapter.editMessage("linq:chat-123", "message-1", { markdown: "**Edited** text" });

    expect(update).toHaveBeenCalledWith("message-1", { text: "Edited text", part_index: 0 });
  });

  it("buffers a stream once and sends its final Markdown through the same compiler", async () => {
    const { adapter, send } = createAdapterHarness();

    await adapter.stream("linq:chat-123", formattedStream());

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("chat-123", {
      message: {
        idempotency_key: expect.any(String),
        parts: [
          {
            type: "text",
            value: "Hello world",
            text_decorations: [{ range: [0, 5], style: "bold" }],
          },
        ],
      },
    });
  });

  it("rejects invalid ranges before provider send or attachment preparation", async () => {
    const { adapter, createAttachment, send } = createAdapterHarness();
    const invalid = {
      raw: "hello",
      files: [{ data: Buffer.from("file"), filename: "file.txt", mimeType: "text/plain" }],
      linq: { decorations: [{ range: [0, 6], style: "bold" }] },
    } as AdapterPostableMessage;

    await expect(adapter.postMessage("linq:chat-123", invalid)).rejects.toBeInstanceOf(
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
  const update = vi.fn().mockResolvedValue({
    chat_id: "chat-123",
    created_at: "2026-08-20T00:00:00.000Z",
    delivery_status: "sent",
    id: "message-1",
    is_from_me: true,
    is_read: false,
    parts: [],
    sent_at: "2026-08-20T00:00:00.000Z",
  });
  const createAttachment = vi.fn();

  Object.assign(adapter.client, {
    chats: { messages: { send } },
    messages: { update },
    attachments: { create: createAttachment },
  });

  return { adapter, createAttachment, send, update };
}

async function* formattedStream() {
  yield { type: "markdown_text", text: "**Hello" } as const;
  yield { type: "markdown_text", text: "** world" } as const;
  yield { type: "task_update", id: "ignored", status: "complete", title: "Ignored" } as const;
}
