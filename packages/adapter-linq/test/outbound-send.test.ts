import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import type { LinqAPIV3 } from "@linqapp/sdk";
import { Card, Chat, Image } from "chat";
import type { AdapterPostableMessage, Attachment, StateAdapter } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLinqAdapter, type LinqAdapter } from "../src/index.js";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("reliable existing-chat send validation", () => {
  it("reuses one explicit idempotency key across the SDK's default retries", async () => {
    const requestBodies: unknown[] = [];
    let attempt = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      attempt += 1;

      if (attempt < 3) {
        return new Response(JSON.stringify({ error: { message: "retry" } }), {
          status: 500,
          headers: { "content-type": "application/json", "retry-after-ms": "0" },
        });
      }

      return new Response(JSON.stringify(createSendResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const adapter = createLinqAdapter({
      apiKey: "test-key",
      baseURL: "https://linq-sdk-retry.example.test",
      signingSecret: "whsec_dGVzdC1zZWNyZXQ=",
    });

    await adapter.postMessage("linq:chat-123", "retry safely");

    expect(requestBodies).toHaveLength(3);
    const keys = requestBodies.map(
      (body) => (body as { message: { idempotency_key: string } }).message.idempotency_key,
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(UUID_PATTERN);
  });

  it("accepts 10,000 text characters and rejects 10,001 before sending", async () => {
    const { adapter, send, create } = createOutboundTestAdapter();

    await adapter.postMessage("linq:chat-123", "a".repeat(10_000));

    expect(send).toHaveBeenCalledTimes(1);

    await expect(adapter.postMessage("linq:chat-123", "a".repeat(10_001))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts 100 total parts and rejects 101 before any side effect", async () => {
    const { adapter, send, create } = createOutboundTestAdapter();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const attachments = Array.from({ length: 40 }, (_, index) => ({
      type: "image" as const,
      url: `https://example.com/image-${index}.png`,
    }));
    const files = Array.from({ length: 59 }, (_, index) => ({
      data: Buffer.from([index]),
      filename: `file-${index}.png`,
      mimeType: "image/png",
    }));

    await adapter.postMessage("linq:chat-123", { markdown: "text", attachments, files });

    expect(send.mock.calls[0]?.[1].message.parts).toHaveLength(100);
    expect(create).toHaveBeenCalledTimes(59);

    send.mockClear();
    create.mockClear();
    fetchSpy.mockClear();

    await expect(
      adapter.postMessage("linq:chat-123", {
        markdown: "",
        attachments: Array.from({ length: 101 }, (_, index) => ({
          type: "image" as const,
          url: `https://example.com/too-many-${index}.png`,
        })),
      }),
    ).rejects.toThrow("100 total parts");
    expect(send).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("counts card images together with ordinary public-URL attachments", async () => {
    const { adapter, send, create } = createOutboundTestAdapter();
    const card = Card({
      title: "Images",
      children: Array.from({ length: 20 }, (_, index) =>
        Image({ url: `https://example.com/card-${index}.png` }),
      ),
    });
    const message = {
      attachments: Array.from({ length: 21 }, (_, index) => ({
        type: "image" as const,
        url: `https://example.com/attachment-${index}.png`,
      })),
      card,
      fallbackText: "Images",
    } as unknown as AdapterPostableMessage;

    await expect(adapter.postMessage("linq:chat-123", message)).rejects.toThrow(
      "40 public-URL media parts",
    );
    expect(send).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects malformed HTTPS parts before Linq receives them", async () => {
    const { adapter, send, create } = createOutboundTestAdapter();

    await expect(
      adapter.postMessage("linq:chat-123", {
        markdown: "",
        attachments: [{ type: "image", url: "https://" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(send).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS URL-only attachments without local network access", async () => {
    const { adapter, send, create } = createOutboundTestAdapter();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      adapter.postMessage("linq:chat-123", {
        markdown: "",
        attachments: [
          {
            mimeType: "image/png",
            name: "private.png",
            type: "image",
            url: "http://127.0.0.1:3000/private.png",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("enforces filename and upload-size boundaries before attachment creation", async () => {
    const { adapter, create } = createOutboundTestAdapter();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await adapter.postMessage("linq:chat-123", {
      markdown: "",
      files: [{ data: Buffer.from([1]), filename: "a".repeat(255), mimeType: "image/png" }],
    });
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ filename: "a".repeat(255), size_bytes: 1 }),
      { maxRetries: 0 },
    );

    create.mockClear();

    for (const file of [
      { data: Buffer.from([1]), filename: "", mimeType: "image/png" },
      { data: Buffer.from([1]), filename: "a".repeat(256), mimeType: "image/png" },
      { data: Buffer.alloc(0), filename: "empty.png", mimeType: "image/png" },
    ]) {
      await expect(
        adapter.postMessage("linq:chat-123", { markdown: "", files: [file] }),
      ).rejects.toBeInstanceOf(ValidationError);
    }

    const fetchData = vi.fn().mockResolvedValue(Buffer.from([1]));

    await adapter.postMessage("linq:chat-123", {
      markdown: "",
      attachments: [
        {
          type: "file",
          name: "max.zip",
          mimeType: "application/zip",
          size: MAX_UPLOAD_BYTES,
          fetchData,
        },
      ],
    });
    expect(fetchData).toHaveBeenCalledTimes(1);

    fetchData.mockClear();
    create.mockClear();

    await expect(
      adapter.postMessage("linq:chat-123", {
        markdown: "",
        attachments: [
          {
            type: "file",
            name: "too-large.zip",
            mimeType: "application/zip",
            size: MAX_UPLOAD_BYTES + 1,
            fetchData,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchData).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a missing attachment source before preparing earlier uploads", async () => {
    const { adapter, create } = createOutboundTestAdapter();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      adapter.postMessage("linq:chat-123", {
        markdown: "",
        attachments: [
          {
            data: Buffer.from([1]),
            mimeType: "image/png",
            name: "valid.png",
            type: "image",
          },
          { mimeType: "image/png", name: "missing.png", type: "image", url: "" },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(create).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not confuse an attachment's extra filename property with a file upload", async () => {
    const { adapter, create, send } = createOutboundTestAdapter();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const attachment = {
      data: Buffer.from([1]),
      filename: "untrusted-extra-field.png",
      mimeType: "image/png",
      name: "attachment-name.png",
      type: "image",
    } as unknown as Attachment;

    await adapter.postMessage("linq:chat-123", { markdown: "", attachments: [attachment] });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "attachment-name.png", size_bytes: 1 }),
      { maxRetries: 0 },
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("reliable existing-chat send retries and idempotency", () => {
  it("generates one fresh UUID idempotency key per postMessage call", async () => {
    const { adapter, send } = createOutboundTestAdapter();

    await adapter.postMessage("linq:chat-123", "one");
    await adapter.postMessage("linq:chat-123", "two");

    const firstKey = send.mock.calls[0]?.[1].message.idempotency_key;
    const secondKey = send.mock.calls[1]?.[1].message.idempotency_key;

    expect(firstKey).toMatch(UUID_PATTERN);
    expect(secondKey).toMatch(UUID_PATTERN);
    expect(secondKey).not.toBe(firstKey);
    expect(send.mock.calls.every((call) => call.length === 2)).toBe(true);
  });

  it("does not add adapter retries around the official SDK message send", async () => {
    const { adapter, send } = createOutboundTestAdapter();
    const original = providerError(500, 3001, "trace-retry");
    send.mockRejectedValue(original);

    await expect(adapter.postMessage("linq:chat-123", "hello")).rejects.toBeInstanceOf(
      AdapterError,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("reliable existing-chat send errors", () => {
  it.each([
    [400, ValidationError],
    [401, AuthenticationError],
    [403, PermissionError],
    [404, ResourceNotFoundError],
    [429, AdapterRateLimitError],
    [500, AdapterError],
  ] as const)(
    "maps Linq HTTP %s failures to the shared error contract",
    async (status, ErrorType) => {
      const { adapter, send } = createOutboundTestAdapter();
      const original = providerError(status, status === 429 ? 1007 : 2001, `trace-${status}`, 17);
      send.mockRejectedValue(original);

      const error = await adapter.postMessage("linq:chat-123", "hello").catch((caught) => caught);

      expect(error).toBeInstanceOf(ErrorType);
      expect(error).toMatchObject({
        cause: original,
        providerCode: status === 429 ? 1007 : 2001,
        traceId: `trace-${status}`,
      });

      if (status === 429) {
        expect(error).toMatchObject({ retryAfter: 17 });
      }
    },
  );

  it("maps connection failures to NetworkError while preserving the original error", async () => {
    const { adapter, send } = createOutboundTestAdapter();
    const original = new Error("socket closed");
    send.mockRejectedValue(original);

    const error = await adapter.postMessage("linq:chat-123", "hello").catch((caught) => caught);

    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toMatchObject({ cause: original, originalError: original });
  });
});

describe("reliable existing-chat attachment cleanup", () => {
  it.each([
    ["missing attachment id", { attachment_id: null }, false],
    ["missing upload URL", { upload_url: null }, true],
    ["wrong method", { http_method: "POST" }, true],
    ["missing headers", { required_headers: null }, true],
    ["non-string header", { required_headers: { "content-type": 42 } }, true],
  ] as const)(
    "rejects provider attachment response with %s before upload",
    async (_label, override, canClean) => {
      const { adapter, create, deleteAttachment, send } = createOutboundTestAdapter();
      create.mockResolvedValueOnce({
        attachment_id: "attachment-malformed",
        download_url: "https://cdn.linqapp.com/attachment-malformed",
        expires_at: "2026-08-02T18:00:00.000Z",
        http_method: "PUT",
        required_headers: { "content-type": "application/octet-stream" },
        upload_url: "https://uploads.linqapp.com/attachment-malformed",
        ...override,
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      await expect(
        adapter.postMessage("linq:chat-123", {
          markdown: "",
          files: [{ data: Buffer.from([1]), filename: "file.png", mimeType: "image/png" }],
        }),
      ).rejects.toBeInstanceOf(AdapterError);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(deleteAttachment).toHaveBeenCalledTimes(canClean ? 1 : 0);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("rejects an unsafe provider upload URL and cleans up the created attachment", async () => {
    const { adapter, create, deleteAttachment, send } = createOutboundTestAdapter();
    create.mockResolvedValueOnce({
      attachment_id: "attachment-unsafe",
      download_url: "https://cdn.linqapp.com/attachment-unsafe",
      expires_at: "2026-08-02T18:00:00.000Z",
      http_method: "PUT",
      required_headers: { "content-type": "application/octet-stream" },
      upload_url: "http://127.0.0.1:3000/upload",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      adapter.postMessage("linq:chat-123", {
        markdown: "",
        files: [{ data: Buffer.from([1]), filename: "file.png", mimeType: "image/png" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(deleteAttachment).toHaveBeenCalledWith("attachment-unsafe");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "not a URL",
    "https://user:secret@uploads.linqapp.com/upload",
    "https://localhost/upload",
    "https://uploads.localhost/upload",
    "https://127.0.0.1/upload",
    "https://0.0.0.0/upload",
    "https://10.1.2.3/upload",
    "https://100.64.0.1/upload",
    "https://169.254.1.1/upload",
    "https://172.16.0.1/upload",
    "https://192.168.1.1/upload",
    "https://224.0.0.1/upload",
    "https://[::]/upload",
    "https://[::1]/upload",
    "https://[fc00::1]/upload",
    "https://[fe80::1]/upload",
    "https://[ff02::1]/upload",
    "https://[::ffff:127.0.0.1]/upload",
    "https://[::ffff:10.0.0.1]/upload",
  ])("rejects provider upload target %s before upload I/O", async (uploadUrl) => {
    const { adapter, create, deleteAttachment, send } = createOutboundTestAdapter();
    create.mockResolvedValueOnce({
      attachment_id: "attachment-local-target",
      download_url: "https://cdn.linqapp.com/attachment-local-target",
      expires_at: "2026-08-02T18:00:00.000Z",
      http_method: "PUT",
      required_headers: { "content-type": "application/octet-stream" },
      upload_url: uploadUrl,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      adapter.postMessage("linq:chat-123", {
        markdown: "",
        files: [{ data: Buffer.from([1]), filename: "file.png", mimeType: "image/png" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(deleteAttachment).toHaveBeenCalledWith("attachment-local-target");
    expect(send).not.toHaveBeenCalled();
  });

  it("bounds a provider-issued upload and preserves timeout over cleanup failure", async () => {
    vi.useFakeTimers();
    const { adapter, deleteAttachment, send } = createOutboundTestAdapter();
    deleteAttachment.mockRejectedValue(new Error("cleanup failed"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

    const result = adapter
      .postMessage("linq:chat-123", {
        markdown: "",
        files: [{ data: Buffer.from([1]), filename: "file.png", mimeType: "image/png" }],
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = (await result) as NetworkError & {
      cause: Error & { cause?: unknown };
    };

    expect(error).toBeInstanceOf(NetworkError);
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause.message).toContain("timed out after 30000ms");
    expect(error.cause.cause).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://uploads.linqapp.com/attachment-1",
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
    expect(deleteAttachment).toHaveBeenCalledWith("attachment-1");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects provider upload redirects and cleans up before message sending", async () => {
    const { adapter, deleteAttachment, send } = createOutboundTestAdapter();
    const redirectFailure = new TypeError("fetch failed: redirect mode is error");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(redirectFailure);

    const error = (await adapter
      .postMessage("linq:chat-123", {
        markdown: "",
        files: [{ data: Buffer.from([1]), filename: "file.png", mimeType: "image/png" }],
      })
      .catch((caught: unknown) => caught)) as NetworkError;

    expect(error).toBeInstanceOf(NetworkError);
    expect(error.cause).toBe(redirectFailure);
    expect(deleteAttachment).toHaveBeenCalledWith("attachment-1");
    expect(send).not.toHaveBeenCalled();
  });

  it("uploads to a public credential-free HTTPS target with a bounded signal", async () => {
    const { adapter, deleteAttachment, send } = createOutboundTestAdapter();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    await adapter.postMessage("linq:chat-123", {
      markdown: "",
      files: [{ data: Buffer.from([1]), filename: "file.png", mimeType: "image/png" }],
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://uploads.linqapp.com/attachment-1",
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
    expect(deleteAttachment).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("best-effort deletes a created attachment when preparation later fails", async () => {
    const { adapter, send, deleteAttachment } = createOutboundTestAdapter();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 500, statusText: "Upload failed" }),
    );
    deleteAttachment.mockRejectedValue(new Error("cleanup failed"));

    const error = await adapter
      .postMessage("linq:chat-123", {
        markdown: "",
        files: [{ data: Buffer.from([1]), filename: "file.png", mimeType: "image/png" }],
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(NetworkError);
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause.message).toContain("Upload failed");
    expect(deleteAttachment).toHaveBeenCalledWith("attachment-1");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not clean up after message sending has begun", async () => {
    const { adapter, send, deleteAttachment } = createOutboundTestAdapter();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    send.mockRejectedValue(providerError(500, 3001, "trace-send"));

    await expect(
      adapter.postMessage("linq:chat-123", {
        markdown: "",
        files: [{ data: Buffer.from([1]), filename: "file.png", mimeType: "image/png" }],
      }),
    ).rejects.toBeInstanceOf(AdapterError);
    expect(deleteAttachment).not.toHaveBeenCalled();
  });

  it("does not retry or clean up after a malformed response from a begun send", async () => {
    const { adapter, send, deleteAttachment } = createOutboundTestAdapter();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    send.mockResolvedValue({ ...createSendResponse(), chat_id: null });

    await expect(
      adapter.postMessage("linq:chat-123", {
        markdown: "",
        files: [{ data: Buffer.from([1]), filename: "file.png", mimeType: "image/png" }],
      }),
    ).rejects.toBeInstanceOf(AdapterError);
    expect(send).toHaveBeenCalledOnce();
    expect(deleteAttachment).not.toHaveBeenCalled();
  });
});

describe("thread.post() contract", () => {
  it("sends through the standard Chat SDK thread handle", async () => {
    const { adapter, send } = createOutboundTestAdapter();
    const state = {
      appendToList: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as StateAdapter;
    const chat = new Chat({
      adapters: { linq: adapter },
      logger: "silent",
      state,
      userName: "linq-test",
    });
    await chat.initialize();

    const sent = await chat.thread("linq:chat-123").post("hello from thread.post");

    expect(sent.id).toBe("outbound-message-id");
    expect(send).toHaveBeenCalledWith("chat-123", {
      message: {
        idempotency_key: expect.stringMatching(UUID_PATTERN),
        parts: [{ type: "text", value: "hello from thread.post" }],
      },
    });
  });

  it("uses the standard Thread.reply() contract with explicit idempotency", async () => {
    const { adapter, send } = createOutboundTestAdapter();
    const chat = createTestChat(adapter);
    await chat.initialize();

    const sent = await chat.thread("linq:chat-123").reply("message-parent", "reply text");

    expect(sent.id).toBe("outbound-message-id");
    expect(send).toHaveBeenCalledWith("chat-123", {
      message: {
        idempotency_key: expect.stringMatching(UUID_PATTERN),
        parts: [{ type: "text", value: "reply text" }],
        reply_to: { message_id: "message-parent" },
      },
    });
  });

  it("uses the standard Thread.markAsRead() contract with Linq's chat-wide semantics", async () => {
    const { adapter, markAsRead } = createOutboundTestAdapter();
    const chat = createTestChat(adapter);
    await chat.initialize();

    await chat.thread("linq:chat-123").markAsRead("message-inbound");

    expect(markAsRead).toHaveBeenCalledWith("chat-123");
  });

  it("keeps released adapter.markRead() as one translated chat-wide acknowledgement", async () => {
    const { adapter, markAsRead } = createOutboundTestAdapter();

    await adapter.markRead("linq:chat-123", "message-inbound");
    expect(markAsRead).toHaveBeenCalledOnce();
    expect(markAsRead).toHaveBeenCalledWith("chat-123");

    const original = providerError(403, 2001, "trace-mark-read");
    markAsRead.mockRejectedValueOnce(original);
    const error = await adapter
      .markRead("linq:chat-123", "message-inbound")
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(PermissionError);
    expect(error).toMatchObject({
      cause: original,
      providerCode: 2001,
      traceId: "trace-mark-read",
    });
  });
});

function createOutboundTestAdapter(): {
  adapter: LinqAdapter;
  create: ReturnType<typeof vi.fn>;
  deleteAttachment: ReturnType<typeof vi.fn>;
  markAsRead: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const adapter = createLinqAdapter({
    apiKey: "test-key",
    signingSecret: "whsec_dGVzdC1zZWNyZXQ=",
  });
  const send = vi.fn().mockResolvedValue(createSendResponse());
  const create = vi.fn().mockImplementation(async () => {
    const attachmentId = `attachment-${create.mock.calls.length}`;

    return {
      attachment_id: attachmentId,
      download_url: `https://cdn.linqapp.com/${attachmentId}`,
      expires_at: "2026-08-02T18:00:00.000Z",
      http_method: "PUT",
      required_headers: { "content-type": "application/octet-stream" },
      upload_url: `https://uploads.linqapp.com/${attachmentId}`,
    };
  });
  const deleteAttachment = vi.fn().mockResolvedValue(undefined);
  const markAsRead = vi.fn().mockResolvedValue(undefined);

  (
    adapter as unknown as {
      apiClient: {
        attachments: { create: typeof create; delete: typeof deleteAttachment };
        chats: { markAsRead: typeof markAsRead; messages: { send: typeof send } };
      };
    }
  ).apiClient = {
    attachments: { create, delete: deleteAttachment },
    chats: { markAsRead, messages: { send } },
  };

  return { adapter, create, deleteAttachment, markAsRead, send };
}

function createTestChat(adapter: LinqAdapter): Chat<{ linq: LinqAdapter }> {
  const state = {
    appendToList: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  } as unknown as StateAdapter;

  return new Chat({
    adapters: { linq: adapter },
    logger: "silent",
    state,
    userName: "linq-test",
  });
}

function createSendResponse(): Awaited<ReturnType<LinqAPIV3["chats"]["messages"]["send"]>> {
  return {
    chat_id: "chat-123",
    message: {
      created_at: "2026-08-02T17:00:00.000Z",
      delivery_status: "queued",
      id: "outbound-message-id",
      is_read: false,
      parts: [],
      sent_at: null,
    },
  };
}

function providerError(status: number, code: number, traceId: string, retryAfter?: number): Error {
  const headers = new Headers({ "x-trace-id": traceId });

  if (retryAfter !== undefined) {
    headers.set("retry-after", String(retryAfter));
  }

  return Object.assign(new Error(`Linq HTTP ${status}`), {
    error: {
      error: {
        code,
        message: `Provider error ${code}`,
        retry_after: retryAfter,
        status,
      },
      success: false,
      trace_id: traceId,
    },
    headers,
    status,
  });
}
