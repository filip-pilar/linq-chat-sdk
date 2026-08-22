import { NotImplementedError, Chat } from "chat";
import type { StateAdapter } from "chat";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createLinqAdapter } from "../src/index.js";
import type { LinqRawMessage } from "../src/index.js";
import historyFixture from "./fixtures/message-history-fidelity.json";

const CHAT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_ID = `linq:${CHAT_ID}`;

describe("Linq history fidelity", () => {
  it("returns usable rows oldest-first when the provider page is reversed", async () => {
    const providerPage = {
      ...historyFixture,
      messages: [...historyFixture.messages].reverse(),
    };
    const { adapter, list, warn } = createHistoryAdapter(providerPage);

    const result = await adapter.fetchMessages(THREAD_ID, {
      cursor: "cursor-newer",
      direction: "backward",
      limit: 25,
    });

    expect(list).toHaveBeenCalledWith(CHAT_ID, { cursor: "cursor-newer", limit: 25 });
    expect(result.messages.map((message) => message.id)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(result.messages.map((message) => message.text)).toEqual(["first", "", "last"]);
    expect(result.nextCursor).toBe("cursor-older");
    expect(warn).toHaveBeenCalledOnce();

    const raw = result.messages[0]?.raw;
    expectTypeOf(raw).toMatchTypeOf<LinqRawMessage | undefined>();
    expect(raw).toEqual(historyFixture.messages[0]);
    expect(raw).toMatchObject({
      effect: { type: "screen", name: "confetti" },
      preferred_service: "iMessage",
      reconciled_at: "2026-08-01T10:05:00.000Z",
      reply_to: { message_id: "99999999-9999-4999-8999-999999999999", part_index: 0 },
      service: "iMessage",
    });
  });

  it("sorts valid timestamps stably while preserving invalid timestamp slots", async () => {
    const base = historyFixture.messages[0];
    if (!base || !("chat_id" in base)) throw new Error("Expected a retrieved-message fixture");
    const row = (id: string, sentAt: unknown, createdAt: unknown) => ({
      ...base,
      id,
      sent_at: sentAt,
      created_at: createdAt,
      parts: [{ type: "text", value: id }],
    });
    const page = {
      messages: [
        row("invalid-slot", "01/02/2026", "not-a-provider-timestamp"),
        row("late", "2026-08-01T10:04:00.000Z", "2026-08-01T10:04:00.000Z"),
        row("missing-slot", null, null),
        row("equal-first", "2026-08-01T10:02:00.000Z", "2026-08-01T10:02:00.000Z"),
        row("early", "2026-08-01T10:01:00.000Z", "2026-08-01T10:01:00.000Z"),
        row("equal-second", "2026-08-01T10:02:00.000Z", "2026-08-01T10:02:00.000Z"),
      ],
      next_cursor: "older",
    };
    const { adapter } = createHistoryAdapter(page);

    const result = await adapter.fetchMessages(THREAD_ID);

    expect(result.messages.map((message) => message.id)).toEqual([
      "invalid-slot",
      "early",
      "missing-slot",
      "equal-first",
      "equal-second",
      "late",
    ]);
    expect(result.messages[0]?.raw).toMatchObject({ sent_at: "01/02/2026" });
    expect(result.messages[2]?.raw).toMatchObject({ sent_at: null, created_at: null });
    expect(result.nextCursor).toBe("older");
  });

  it("returns all tombstone rows and their cursor without fabricating text", async () => {
    const tombstones = historyFixture.messages
      .filter((row) => "chat_id" in row)
      .slice(0, 2)
      .map((row) => ({ ...row, parts: null }));
    const { adapter } = createHistoryAdapter({ messages: tombstones, next_cursor: "older" });

    const result = await adapter.fetchMessages(THREAD_ID);

    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((message) => message.text)).toEqual(["", ""]);
    expect(
      result.messages.map((message) => ("parts" in message.raw ? message.raw.parts : undefined)),
    ).toEqual([null, null]);
    expect(result.nextCursor).toBe("older");
  });

  it("freezes default backward Chat SDK iteration and rejects unsupported forward history", async () => {
    const page = { ...historyFixture, next_cursor: null };
    const { adapter, list } = createHistoryAdapter(page);
    const chat = new Chat({
      adapters: { linq: adapter },
      logger: "silent",
      state: stateStub(),
      userName: "history-fidelity-test",
    });
    await chat.initialize();

    const ids: string[] = [];
    for await (const message of chat.thread(THREAD_ID).messages) ids.push(message.id);

    expect(ids).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    await expect(adapter.fetchMessages(THREAD_ID, { direction: "forward" })).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("skips all-malformed provider pages so Chat SDK iteration reaches usable history", async () => {
    const adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: "test-secret" });
    const usable = historyFixture.messages[0];
    const list = vi
      .fn()
      .mockResolvedValueOnce({ messages: [{ id: null }], next_cursor: "cursor-after-bad" })
      .mockResolvedValueOnce({ messages: [usable], next_cursor: null });
    const warn = vi.fn();
    Object.assign(adapter.client, { chats: { messages: { list } } });
    const chat = new Chat({
      adapters: { linq: adapter },
      logger: "silent",
      state: stateStub(),
      userName: "history-fidelity-test",
    });
    await chat.initialize();
    (adapter as unknown as { logger: { warn: typeof warn } }).logger = { warn };

    const ids: string[] = [];
    for await (const message of chat.thread(THREAD_ID).messages) ids.push(message.id);

    expect(ids).toEqual([usable?.id]);
    expect(list).toHaveBeenNthCalledWith(1, CHAT_ID, { cursor: undefined, limit: undefined });
    expect(list).toHaveBeenNthCalledWith(2, CHAT_ID, {
      cursor: "cursor-after-bad",
      limit: undefined,
    });
    expect(warn).toHaveBeenCalledWith("Skipping malformed Linq history row", {
      error: expect.any(Error),
    });
  });

  it("stops safely when an empty filtered page repeats its cursor", async () => {
    const { adapter, list, warn } = createHistoryAdapter({
      messages: [{ id: null }],
      next_cursor: "cursor-cycle",
    });

    const result = await adapter.fetchMessages(THREAD_ID, { cursor: "cursor-cycle" });

    expect(result).toEqual({ messages: [], nextCursor: undefined });
    expect(list).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("Stopping Linq history pagination after a repeated cursor", {
      cursor: "cursor-cycle",
    });
  });

  it("bounds consecutive filtered pages even when every cursor is unique", async () => {
    const adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: "test-secret" });
    const list = vi.fn().mockImplementation(async () => ({
      messages: [{ id: null }],
      next_cursor: `cursor-${list.mock.calls.length}`,
    }));
    const warn = vi.fn();
    Object.assign(adapter.client, { chats: { messages: { list } } });
    (adapter as unknown as { logger: { warn: typeof warn } }).logger = { warn };

    const result = await adapter.fetchMessages(THREAD_ID);

    expect(result).toEqual({ messages: [], nextCursor: undefined });
    expect(list).toHaveBeenCalledTimes(10);
    expect(warn).toHaveBeenCalledWith(
      "Stopping Linq history pagination after too many filtered pages",
      { count: 10 },
    );
  });
});

function createHistoryAdapter(page: unknown) {
  const adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: "test-secret" });
  const list = vi.fn().mockResolvedValue(page);
  const warn = vi.fn();
  Object.assign(adapter.client, { chats: { messages: { list } } });
  (adapter as unknown as { logger: { warn: typeof warn } }).logger = { warn };

  return { adapter, list, warn };
}

function stateStub(): StateAdapter {
  return {
    appendToList: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  } as unknown as StateAdapter;
}
