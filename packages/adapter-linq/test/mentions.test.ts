import { createHmac } from "node:crypto";

import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import { Chat, paragraph, root, text } from "chat";
import type { AdapterPostableMessage, ChatInstance, StateAdapter } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLinqAdapter, linqMessage, type LinqAdapter } from "../src/index.js";
import fixture from "./fixtures/message-received-2026-02-03.json";

const CHAT_ID = "11111111-1111-1111-1111-111111111111";
const MESSAGE_ID = "22222222-2222-2222-2222-222222222222";
const PARTICIPANT_ID = "33333333-3333-3333-3333-333333333333";
const OWNER_HANDLE = "owner@example.com";
const TARGET_HANDLE = "+15550002000";
const SIGNING_KEY = "test_linq_webhook_secret";
const SIGNING_SECRET = `whsec_${Buffer.from(SIGNING_KEY).toString("base64")}`;

const { adapterRandomUUID } = vi.hoisted(() => ({ adapterRandomUUID: vi.fn() }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: (options?: { disableEntropyCache?: boolean }) => {
      adapterRandomUUID();
      return actual.randomUUID(options);
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  adapterRandomUUID.mockClear();
});

describe("native Linq mentions", () => {
  it("translates explicit UTF-16 ranges immutably with SMS/plain-text compatibility", async () => {
    const { adapter, send } = createHarness(true);
    const range: [number, number] = [3, 8];
    const options = { mention: { handle: TARGET_HANDLE, range }, preferredService: "SMS" } as const;
    const message = linqMessage("👋 Kevin", options);

    range[1] = 4;
    await adapter.postMessage(`linq:${CHAT_ID}`, message);

    expect(send).toHaveBeenCalledWith(CHAT_ID, {
      message: {
        idempotency_key: expect.any(String),
        preferred_service: "SMS",
        parts: [
          {
            type: "text",
            value: "👋 Kevin",
            mention: TARGET_HANDLE,
            mention_range: [3, 8],
          },
        ],
      },
    });
    expect(Object.isFrozen(message.linq.mention)).toBe(true);
    expect(Object.isFrozen(message.linq.mention?.range)).toBe(true);
  });

  it.each([TARGET_HANDLE, "kevin@example.com"])(
    "translates one complete Chat SDK mention token for %s without lookup",
    async (targetHandle) => {
      const { adapter, retrieve, send } = createHarness(true);
      adapterRandomUUID.mockClear();

      await adapter.postMessage(`linq:${CHAT_ID}`, `Hi (<@${targetHandle}>), welcome!`);

      expect(retrieve).not.toHaveBeenCalled();
      expect(adapterRandomUUID).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[1].message.parts).toEqual([
        {
          type: "text",
          value: `Hi (${targetHandle}), welcome!`,
          mention: targetHandle,
          mention_range: [4, 4 + targetHandle.length],
        },
      ]);
    },
  );

  it("uses Thread.mentionUser() through ordinary Chat SDK post and reply paths", async () => {
    const { adapter, retrieve, send } = createHarness(true);
    const chat = new Chat({
      adapters: { linq: adapter },
      logger: "silent",
      state: { connect: vi.fn(), disconnect: vi.fn() } as unknown as StateAdapter,
      userName: "mention-outbound-test",
    });
    await chat.initialize();
    const thread = chat.thread(`linq:${CHAT_ID}`);

    await thread.post(`Hi ${thread.mentionUser(PARTICIPANT_ID)}`);
    await thread.reply(MESSAGE_ID, `Replying to ${thread.mentionUser(TARGET_HANDLE)}`);

    expect(retrieve).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[1].message.parts[0]).toMatchObject({ mention: TARGET_HANDLE });
    expect(send.mock.calls[1]?.[1].message).toMatchObject({
      reply_to: { message_id: MESSAGE_ID },
      parts: [expect.objectContaining({ mention: TARGET_HANDLE })],
    });
  });

  it("preserves ordinary angle-bracket text and compiles AST mention text with media", async () => {
    const { adapter, retrieve, send } = createHarness(true);

    await adapter.postMessage(`linq:${CHAT_ID}`, "Compare <one> and 2 < 3 > 1.");
    await adapter.postMessage(`linq:${CHAT_ID}`, {
      ast: root([paragraph([text(`AST <@${TARGET_HANDLE}>`)])]),
      attachments: [{ type: "image", url: "https://example.com/photo.png" }],
    });

    expect(retrieve).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[1].message.parts).toEqual([
      { type: "text", value: "Compare <one> and 2 < 3 > 1." },
    ]);
    expect(send.mock.calls[1]?.[1].message.parts).toEqual([
      {
        type: "text",
        value: `AST ${TARGET_HANDLE}`,
        mention: TARGET_HANDLE,
        mention_range: [4, 4 + TARGET_HANDLE.length],
      },
      { type: "media", url: "https://example.com/photo.png" },
    ]);
  });

  it.each([
    ["nested opening", `Hi <@<@${TARGET_HANDLE}>>`],
    ["ambiguous outer wrapper", `Hi <<@${TARGET_HANDLE}>>`],
    ["empty target", "Hi <@>"],
    ["unclosed token", `Hi <@${TARGET_HANDLE}`],
    ["extra opening delimiter", `Hi <<@${TARGET_HANDLE}>`],
    ["extra closing delimiter", `Hi <@${TARGET_HANDLE}>>`],
    ["multiple targets", `Hi <@${TARGET_HANDLE}> and <@owner@example.com>`],
    ["valid plus malformed", `Hi <@${TARGET_HANDLE}> and <@owner@example.com`],
  ])(
    "rejects %s before credentials, UUIDs, logging, media, or provider I/O",
    async (_name, raw) => {
      const credentials = vi.fn().mockResolvedValue({ apiKey: "unused-key" });
      const logger = silentLogger();
      const adapter = createLinqAdapter({ credentials, webhookVerifier: () => true });
      adapter.encodeThreadId({ chatId: CHAT_ID, isGroup: true });
      await adapter.initialize({
        getLogger: () => logger,
        getState: () => ({ setIfNotExists: vi.fn() }) as unknown as StateAdapter,
        processMessage: vi.fn(),
        processReaction: vi.fn(),
      } as unknown as ChatInstance);
      const fetch = vi.spyOn(globalThis, "fetch");
      for (const method of [logger.debug, logger.error, logger.info, logger.warn])
        method.mockClear();
      adapterRandomUUID.mockClear();

      const message = {
        raw,
        files: [
          { data: Buffer.from("not prepared"), filename: "note.txt", mimeType: "text/plain" },
        ],
      } as AdapterPostableMessage;
      await expect(adapter.postMessage(`linq:${CHAT_ID}`, message)).rejects.toBeInstanceOf(
        ValidationError,
      );

      expect(credentials).not.toHaveBeenCalled();
      expect(adapterRandomUUID).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      for (const method of [logger.debug, logger.error, logger.info, logger.warn]) {
        expect(method).not.toHaveBeenCalled();
      }
    },
  );

  it("resolves a provider participant ID once on the same client snapshot", async () => {
    const { adapter, retrieve, send } = createHarness(true);

    await adapter.reply(
      `linq:${CHAT_ID}`,
      MESSAGE_ID,
      linqMessage({ markdown: `Hello **<@${PARTICIPANT_ID}>**` }, { preferredService: "RCS" }),
    );

    expect(retrieve).toHaveBeenCalledOnce();
    expect(retrieve).toHaveBeenCalledWith(CHAT_ID);
    expect(send.mock.calls[0]?.[1].message).toMatchObject({
      preferred_service: "RCS",
      reply_to: { message_id: MESSAGE_ID },
      parts: [
        {
          type: "text",
          value: `Hello ${TARGET_HANDLE}`,
          mention: TARGET_HANDLE,
          mention_range: [6, 6 + TARGET_HANDLE.length],
        },
      ],
    });
  });

  it("uses one lazy client snapshot for participant resolution and send", async () => {
    const credentials = vi.fn().mockResolvedValue({ apiKey: "rotating-mention-key" });
    const authorizations: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if ((init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            id: CHAT_ID,
            is_group: true,
            handles: [
              {
                id: PARTICIPANT_ID,
                handle: TARGET_HANDLE,
                joined_at: "2026-08-22T00:00:00Z",
                service: "iMessage",
                status: "active",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      expect(String(input)).toContain(`/chats/${CHAT_ID}/messages`);
      return new Response(
        JSON.stringify({
          chat_id: CHAT_ID,
          message: {
            id: MESSAGE_ID,
            created_at: "2026-08-22T00:00:00Z",
            sent_at: null,
            parts: [],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const adapter = createLinqAdapter({
      baseURL: "https://mention-snapshot.example.test",
      credentials,
      webhookVerifier: () => true,
    });
    adapter.encodeThreadId({ chatId: CHAT_ID, isGroup: true });

    await adapter.postMessage(`linq:${CHAT_ID}`, `<@${PARTICIPANT_ID}>`);

    expect(credentials).toHaveBeenCalledOnce();
    expect(authorizations).toEqual(["Bearer rotating-mention-key", "Bearer rotating-mention-key"]);
  });

  it.each([
    ["active with a null leave time", participantRecord({ status: "active", left_at: null })],
    ["omitted status and leave time", participantRecord({}, ["status", "left_at"])],
    ["null status and leave time", participantRecord({ status: null, left_at: null })],
  ])("resolves a current participant represented as %s", async (_name, participant) => {
    const { adapter, retrieve, send } = createHarness(true);
    retrieve.mockResolvedValueOnce(chatResponse([participant]));

    await adapter.postMessage(`linq:${CHAT_ID}`, `<@${PARTICIPANT_ID}>`);

    expect(retrieve).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1].message.parts[0]).toMatchObject({ mention: TARGET_HANDLE });
  });

  it.each([
    ["left status", participantRecord({ status: "left", left_at: null })],
    ["removed status", participantRecord({ status: "removed", left_at: null })],
    [
      "omitted status with leave evidence",
      participantRecord({ left_at: "2026-08-21T23:00:00Z" }, ["status"]),
    ],
    [
      "null status with leave evidence",
      participantRecord({ status: null, left_at: "2026-08-21T23:00:00Z" }),
    ],
  ])("rejects a no-longer-current participant represented as %s", async (_name, participant) => {
    const { adapter, createAttachment, retrieve, send } = createHarness(true);
    const logger = silentLogger();
    await initializeWithLogger(adapter, logger);
    retrieve.mockResolvedValueOnce(chatResponse([participant]));
    clearLogger(logger);
    adapterRandomUUID.mockClear();

    await expect(
      adapter.postMessage(`linq:${CHAT_ID}`, participantMentionWithFile()),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(send).not.toHaveBeenCalled();
    expect(createAttachment).not.toHaveBeenCalled();
    expect(adapterRandomUUID).not.toHaveBeenCalled();
    expectLoggerUnused(logger);
  });

  it.each([
    [
      "active status with leave evidence",
      chatResponse([participantRecord({ status: "active", left_at: "2026-08-21T23:00:00Z" })]),
    ],
    ["unknown status", chatResponse([participantRecord({ status: "departed" })])],
    ["malformed status", chatResponse([participantRecord({ status: 42 })])],
    ["malformed leave time", chatResponse([participantRecord({ left_at: "not-a-date" })])],
    ["malformed handle", chatResponse([participantRecord({ handle: "not a handle" })])],
    ["malformed collection entry", chatResponse([null])],
    ["duplicate participant ID", chatResponse([participantRecord(), participantRecord()])],
    [
      "cross-chat response",
      chatResponse(undefined, { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
    ],
  ])("rejects malformed provider membership facts: %s", async (_name, response) => {
    const { adapter, createAttachment, retrieve, send } = createHarness(true);
    const logger = silentLogger();
    await initializeWithLogger(adapter, logger);
    retrieve.mockResolvedValueOnce(response);
    clearLogger(logger);
    adapterRandomUUID.mockClear();

    const error = await adapter
      .postMessage(`linq:${CHAT_ID}`, participantMentionWithFile())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect(error).not.toBeInstanceOf(ValidationError);
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    expect(send).not.toHaveBeenCalled();
    expect(createAttachment).not.toHaveBeenCalled();
    expect(adapterRandomUUID).not.toHaveBeenCalled();
    expectLoggerUnused(logger);
  });

  it.each([
    [400, ValidationError],
    [401, AuthenticationError],
    [403, PermissionError],
    [404, ResourceNotFoundError],
    [429, AdapterRateLimitError],
    [500, AdapterError],
    [undefined, NetworkError],
  ] as const)("translates participant-resolution provider status %s", async (status, ErrorType) => {
    const { adapter, createAttachment, retrieve, send } = createHarness(true);
    const original =
      status === undefined
        ? new Error("network unavailable")
        : providerError(status, status === 429 ? 1007 : 2001, `trace-${status}`, 7);
    retrieve.mockRejectedValueOnce(original);
    adapterRandomUUID.mockClear();

    const error = await adapter
      .postMessage(`linq:${CHAT_ID}`, participantMentionWithFile())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ErrorType);
    expect((error as Error).cause).toBe(original);
    if (status !== undefined) {
      expect(error).toMatchObject({ providerCode: status === 429 ? 1007 : 2001 });
    }
    expect(send).not.toHaveBeenCalled();
    expect(createAttachment).not.toHaveBeenCalled();
    expect(adapterRandomUUID).not.toHaveBeenCalled();
  });

  it("allows media but rejects mention conflicts and unsupported paths before sending", async () => {
    const { adapter, send, retrieve } = createHarness(true);

    await adapter.postMessage(
      `linq:${CHAT_ID}`,
      linqMessage(
        {
          raw: "Photo",
          attachments: [{ type: "image", url: "https://example.com/photo.png" }],
        },
        { mention: { handle: TARGET_HANDLE } },
      ),
    );
    expect(send.mock.calls[0]?.[1].message.parts).toEqual([
      { type: "text", value: "Photo", mention: TARGET_HANDLE },
      { type: "media", url: "https://example.com/photo.png" },
    ]);

    const invalidMessages = [
      linqMessage("hello", {
        mention: { handle: TARGET_HANDLE },
        decorations: [{ range: [0, 5], animation: "shake" }],
      }),
      linqMessage("", { mention: { handle: TARGET_HANDLE }, richLink: "https://example.com" }),
      linqMessage(`<@${TARGET_HANDLE}> <@owner@example.com>`, {}),
      linqMessage("hello", { mention: { handle: TARGET_HANDLE, range: [2, 2] } }),
    ];

    send.mockClear();
    for (const message of invalidMessages) {
      await expect(adapter.postMessage(`linq:${CHAT_ID}`, message)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    await expect(
      adapter.editMessage(
        `linq:${CHAT_ID}`,
        MESSAGE_ID,
        linqMessage("hello", { mention: { handle: TARGET_HANDLE } }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      adapter.postMessage(`linq:pending:${TARGET_HANDLE}`, `<@${TARGET_HANDLE}>`),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(send).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("rejects known direct chats and unresolved participant IDs before send or media work", async () => {
    const direct = createHarness(false);
    await expect(
      direct.adapter.postMessage(`linq:${CHAT_ID}`, `<@${TARGET_HANDLE}>`),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(direct.retrieve).not.toHaveBeenCalled();
    expect(direct.send).not.toHaveBeenCalled();

    const credentials = vi.fn().mockResolvedValue({ apiKey: "unused-key" });
    const lazyDirect = createLinqAdapter({ credentials, webhookVerifier: () => true });
    lazyDirect.encodeThreadId({ chatId: CHAT_ID, isGroup: false });
    await expect(
      lazyDirect.postMessage(`linq:${CHAT_ID}`, `<@${TARGET_HANDLE}>`),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(credentials).not.toHaveBeenCalled();

    const group = createHarness(true);
    group.retrieve.mockResolvedValueOnce({ id: CHAT_ID, is_group: true, handles: [] });
    await expect(
      group.adapter.postMessage(`linq:${CHAT_ID}`, `<@${PARTICIPANT_ID}>`),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(group.send).not.toHaveBeenCalled();
  });

  it("translates provider failures from participant resolution", async () => {
    const harness = createHarness(true);
    harness.retrieve.mockRejectedValueOnce(
      Object.assign(new Error("missing chat"), { status: 404 }),
    );

    await expect(
      harness.adapter.postMessage(`linq:${CHAT_ID}`, `<@${PARTICIPANT_ID}>`),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("marks only a valid owner-targeted authenticated group mention", async () => {
    const adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: SIGNING_SECRET });
    const processMessage = vi.fn();
    const payload = mentionPayload(OWNER_HANDLE);
    await adapter.initialize({
      getLogger: () => silentLogger(),
      getState: () =>
        ({ setIfNotExists: vi.fn().mockResolvedValue(true) }) as unknown as StateAdapter,
      processMessage,
      processReaction: vi.fn(),
    } as unknown as ChatInstance);

    const response = await adapter.handleWebhook(createStandardRequest(payload));
    const factory = processMessage.mock.calls[0]?.[2] as () => Promise<unknown>;
    const message = (await factory()) as {
      isMention?: boolean;
      author: { userId: string; userName: string };
    };
    const verified = await adapter.verifyWebhook(createStandardRequest(payload));

    expect(response.status).toBe(200);
    expect(message.isMention).toBe(true);
    expect(message.author).toMatchObject({
      userId: payload.data.sender_handle.id,
      userName: payload.data.sender_handle.handle,
    });
    expect(verified).toMatchObject({
      ok: true,
      webhook: {
        kind: "message.received",
        message: {
          partObservations: [
            expect.objectContaining({
              mentionTarget: OWNER_HANDLE,
              mentionRange: [3, 8],
            }),
          ],
        },
      },
    });

    for (const mutate of [
      (value: ReturnType<typeof mentionPayload>) => {
        (value.data.parts[0] as unknown as { mention: string }).mention = "other@example.com";
      },
      (value: ReturnType<typeof mentionPayload>) => {
        (value.data.parts[0] as unknown as { mention_range: number[] }).mention_range = [8, 3];
      },
      (value: ReturnType<typeof mentionPayload>) => {
        (value.data.parts[0] as unknown as { text_decorations: unknown }).text_decorations = {
          malformed: true,
        };
      },
      (value: ReturnType<typeof mentionPayload>) => {
        value.data.chat.is_group = false;
      },
    ]) {
      const candidate = mentionPayload(OWNER_HANDLE);
      mutate(candidate);
      const candidateAdapter = createLinqAdapter({
        apiKey: "test-key",
        signingSecret: SIGNING_SECRET,
      });
      const candidateProcess = vi.fn();
      await candidateAdapter.initialize({
        getLogger: () => silentLogger(),
        getState: () =>
          ({ setIfNotExists: vi.fn().mockResolvedValue(true) }) as unknown as StateAdapter,
        processMessage: candidateProcess,
        processReaction: vi.fn(),
      } as unknown as ChatInstance);
      await candidateAdapter.handleWebhook(createStandardRequest(candidate));
      const candidateFactory = candidateProcess.mock.calls[0]?.[2] as () => Promise<unknown>;
      expect(await candidateFactory()).not.toMatchObject({ isMention: true });
    }
  });

  it("routes native owner mentions through Chat SDK onNewMention", async () => {
    const adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: SIGNING_SECRET });
    const state = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      isSubscribed: vi.fn().mockResolvedValue(false),
      setIfNotExists: vi.fn().mockResolvedValue(true),
    } as unknown as StateAdapter;
    const chat = new Chat({
      adapters: { linq: adapter },
      concurrency: "concurrent",
      logger: "silent",
      state,
      userName: "mention-test",
    });
    const mention = vi.fn();
    const tasks: Promise<unknown>[] = [];
    chat.onNewMention(mention);
    await chat.initialize();

    const response = await adapter.handleWebhook(
      createStandardRequest(mentionPayload(OWNER_HANDLE)),
      {
        waitUntil: (task) => tasks.push(task),
      },
    );
    await Promise.all(tasks);

    expect(response.status).toBe(200);
    expect(mention).toHaveBeenCalledOnce();
    expect(mention.mock.calls[0]?.[1]).toMatchObject({ isMention: true });
  });
});

function createHarness(isGroup: boolean): {
  adapter: LinqAdapter;
  createAttachment: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: SIGNING_SECRET });
  const createAttachment = vi.fn();
  const send = vi.fn().mockResolvedValue({
    chat_id: CHAT_ID,
    message: { id: MESSAGE_ID, created_at: "2026-08-22T00:00:00Z", sent_at: null, parts: [] },
  });
  const retrieve = vi.fn().mockResolvedValue(chatResponse());
  Object.assign(adapter.client.attachments, { create: createAttachment });
  Object.assign(adapter.client.chats, { retrieve });
  Object.assign(adapter.client.chats.messages, { send });
  adapter.encodeThreadId({ chatId: CHAT_ID, isGroup });
  return { adapter, createAttachment, retrieve, send };
}

function participantRecord(
  overrides: Record<string, unknown> = {},
  omitted: readonly string[] = [],
): Record<string, unknown> {
  const participant: Record<string, unknown> = {
    id: PARTICIPANT_ID,
    handle: TARGET_HANDLE,
    joined_at: "2026-08-22T00:00:00Z",
    left_at: null,
    service: "iMessage",
    status: "active",
    ...overrides,
  };
  for (const field of omitted) delete participant[field];
  return participant;
}

function chatResponse(
  handles: readonly unknown[] = [participantRecord()],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: CHAT_ID,
    is_group: true,
    handles: [...handles],
    ...overrides,
  };
}

function mentionPayload(ownerHandle: string) {
  const payload = structuredClone(fixture);
  payload.event_id = `mention-${crypto.randomUUID()}`;
  payload.data.chat.id = CHAT_ID;
  payload.data.chat.is_group = true;
  payload.data.chat.owner_handle.handle = ownerHandle;
  payload.data.parts = [
    {
      type: "text",
      value: "Hi owner",
      mention: ownerHandle,
      mention_range: [3, 8],
      text_decorations: null,
    } as never,
  ];
  return payload;
}

function createStandardRequest(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const webhookId = crypto.randomUUID();
  const signature = `v1,${createHmac("sha256", SIGNING_KEY)
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest("base64")}`;
  return new Request("https://example.com/webhooks/linq", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-signature": signature,
      "webhook-timestamp": timestamp,
    },
    body,
  });
}

function participantMentionWithFile(): AdapterPostableMessage {
  return {
    raw: `File for <@${PARTICIPANT_ID}>`,
    files: [
      {
        data: Buffer.from("not prepared"),
        filename: "mention.txt",
        mimeType: "text/plain",
      },
    ],
  } as AdapterPostableMessage;
}

async function initializeWithLogger(
  adapter: LinqAdapter,
  logger: ReturnType<typeof silentLogger>,
): Promise<void> {
  await adapter.initialize({
    getLogger: () => logger,
    getState: () => ({ setIfNotExists: vi.fn() }) as unknown as StateAdapter,
    processMessage: vi.fn(),
    processReaction: vi.fn(),
  } as unknown as ChatInstance);
}

function clearLogger(logger: ReturnType<typeof silentLogger>): void {
  for (const method of [logger.debug, logger.error, logger.info, logger.warn]) method.mockClear();
}

function expectLoggerUnused(logger: ReturnType<typeof silentLogger>): void {
  for (const method of [logger.debug, logger.error, logger.info, logger.warn]) {
    expect(method).not.toHaveBeenCalled();
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

function silentLogger() {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return logger;
}
