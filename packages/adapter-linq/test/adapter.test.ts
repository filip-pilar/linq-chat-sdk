import { createHmac } from "node:crypto";
import type { LinqAPIV3 } from "@linqapp/sdk";
import { getEmoji } from "chat";
import type { ChatInstance } from "chat";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createLinqAdapter } from "../src/adapter";
import type { LinqRawMessage } from "../src/message-parser";
import type {
  LinqMessageReceivedWebhookEvent,
  LinqReactionWebhookData,
  LinqReactionWebhookEvent,
} from "../src/webhook";

const SIGNING_KEY = "test_linq_webhook_secret";
const SIGNING_SECRET = `whsec_${Buffer.from(SIGNING_KEY).toString("base64")}`;
const API_KEY = "test_linq_api_key";

describe("LinqAdapter.handleWebhook", () => {
  it("dispatches a stable thread ID and learns DM identity from the webhook", async () => {
    const adapter = createTestAdapter();
    const processMessage = vi.fn(
      async (..._args: Parameters<ChatInstance["processMessage"]>) => {},
    );
    (adapter as unknown as { chat: Pick<ChatInstance, "processMessage"> }).chat = {
      processMessage,
    };

    const response = await adapter.handleWebhook(
      createSignedRequest(createMessageReceivedPayload()),
    );

    expect(response.status).toBe(200);
    expect(processMessage).toHaveBeenCalledWith(
      adapter,
      "linq:3caaf1a0-ef9f-46e0-8c22-31e82c8514dc",
      expect.any(Function),
      undefined,
    );
    expect(adapter.isDM("linq:3caaf1a0-ef9f-46e0-8c22-31e82c8514dc")).toBe(true);
  });

  it("reuses an already-known chat kind when a later webhook omits it", async () => {
    const adapter = createTestAdapter();
    const processMessage = vi.fn(
      async (..._args: Parameters<ChatInstance["processMessage"]>) => {},
    );
    (adapter as unknown as { chat: Pick<ChatInstance, "processMessage"> }).chat = {
      processMessage,
    };
    const retrieve = vi.fn();
    (adapter as unknown as { apiClient: { chats: { retrieve: typeof retrieve } } }).apiClient = {
      chats: { retrieve },
    };

    await adapter.handleWebhook(createSignedRequest(createMessageReceivedPayload()));
    const original = createMessageReceivedPayload();
    const payload = {
      ...original,
      event_id: "event-with-cached-kind",
      data: { ...original.data, chat: { ...original.data.chat, is_group: undefined } },
    };

    const response = await adapter.handleWebhook(createSignedRequest(payload));

    expect(response.status).toBe(200);
    expect(retrieve).not.toHaveBeenCalled();
    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(adapter.isDM("linq:3caaf1a0-ef9f-46e0-8c22-31e82c8514dc")).toBe(true);
  });

  it("dispatches reaction.added webhooks to Chat SDK", async () => {
    const adapter = createTestAdapter();
    const processReaction = vi.fn((..._args: Parameters<ChatInstance["processReaction"]>) => {});
    (adapter as unknown as { chat: Pick<ChatInstance, "processReaction"> }).chat = {
      processReaction,
    };

    const response = await adapter.handleWebhook(createSignedRequest(createReactionPayload()));

    expect(response.status).toBe(200);
    expect(processReaction).toHaveBeenCalledTimes(1);
    expect(processReaction).toHaveBeenCalledWith(
      {
        adapter,
        added: true,
        emoji: getEmoji("thumbs_up"),
        rawEmoji: "like",
        messageId: "e230c922-3e96-4376-9332-67b644d11237",
        threadId: "linq:3caaf1a0-ef9f-46e0-8c22-31e82c8514dc",
        raw: expect.objectContaining({ event_type: "reaction.added" }),
        user: {
          userId: "1fcfb06a-99d6-4df5-9e26-d8a5b1be24ed",
          userName: "+15550002000",
          fullName: "+15550002000",
          isBot: false,
          isMe: false,
        },
      },
      undefined,
    );
  });

  it("dispatches reaction.removed webhooks as removed reactions", async () => {
    const adapter = createTestAdapter();
    const processReaction = vi.fn((..._args: Parameters<ChatInstance["processReaction"]>) => {});
    (adapter as unknown as { chat: Pick<ChatInstance, "processReaction"> }).chat = {
      processReaction,
    };

    const response = await adapter.handleWebhook(
      createSignedRequest(createReactionPayload("reaction.removed", { reaction_type: "love" })),
    );

    expect(response.status).toBe(200);
    expect(processReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        added: false,
        emoji: getEmoji("heart"),
        rawEmoji: "love",
      }),
      undefined,
    );
  });

  it("ignores reaction webhooks without an emoji equivalent", async () => {
    const adapter = createTestAdapter();
    const processReaction = vi.fn((..._args: Parameters<ChatInstance["processReaction"]>) => {});
    (adapter as unknown as { chat: Pick<ChatInstance, "processReaction"> }).chat = {
      processReaction,
    };

    const response = await adapter.handleWebhook(
      createSignedRequest(createReactionPayload("reaction.added", { reaction_type: "sticker" })),
    );

    expect(response.status).toBe(200);
    expect(processReaction).not.toHaveBeenCalled();
  });

  it("ignores reaction webhooks without chat or message IDs", async () => {
    const adapter = createTestAdapter();
    const processReaction = vi.fn((..._args: Parameters<ChatInstance["processReaction"]>) => {});
    (adapter as unknown as { chat: Pick<ChatInstance, "processReaction"> }).chat = {
      processReaction,
    };

    const response = await adapter.handleWebhook(
      createSignedRequest(createReactionPayload("reaction.added", { message_id: undefined })),
    );

    expect(response.status).toBe(200);
    expect(processReaction).not.toHaveBeenCalled();
  });
});

describe("LinqAdapter.parseMessage", () => {
  it("uses the adapter-owned current webhook data at the raw message boundary", () => {
    const event = createMessageReceivedPayload();

    expectTypeOf(event.data).toMatchTypeOf<LinqRawMessage>();
  });

  it("normalizes text message.received data", () => {
    const adapter = createTestAdapter();
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");

    const message = adapter.parseMessage(createMessageReceivedPayload().data);

    expect(message.id).toBe("e230c922-3e96-4376-9332-67b644d11237");
    expect(message.threadId).toBe("linq:chat-123");
    expect(message.text).toBe("hi");
    expect(message.author).toMatchObject({
      userId: "1fcfb06a-99d6-4df5-9e26-d8a5b1be24ed",
      userName: "+15550002000",
      fullName: "+15550002000",
      isBot: false,
      isMe: false,
    });
    expect(message.metadata.dateSent.toISOString()).toBe("2026-05-08T16:21:12.499Z");
    expect(message.metadata.edited).toBe(false);
    expect(message.attachments).toEqual([]);
    expect(message.links).toEqual([]);
  });

  it("keeps inbound Markdown markers literal instead of inventing formatting", () => {
    const adapter = createTestAdapter();
    const payload = createMessageReceivedPayload();
    payload.data.parts = [{ type: "text", value: "**literal**", text_decorations: null }];

    const message = adapter.parseMessage(payload.data);

    expect(message.text).toBe("**literal**");
    expect(message.formatted).toEqual({
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "**literal**" }],
        },
      ],
    });
  });

  it("normalizes URLs in text as links", () => {
    const adapter = createTestAdapter();
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");
    const payload = createMessageReceivedPayload();
    payload.data.parts = [
      {
        type: "text",
        value: "check this out https://example.com and https://trybehold.com.",
        text_decorations: null,
      },
    ];

    const message = adapter.parseMessage(payload.data);

    expect(message.text).toBe("check this out https://example.com and https://trybehold.com.");
    expect(message.links).toEqual([
      { url: "https://example.com" },
      { url: "https://trybehold.com" },
    ]);
  });

  it("normalizes link parts as text and links", () => {
    const adapter = createTestAdapter();
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");
    const payload = createMessageReceivedPayload();
    payload.data.parts = [
      {
        type: "link",
        value: "https://example.com",
      },
    ];

    const message = adapter.parseMessage(payload.data);

    expect(message.text).toBe("https://example.com");
    expect(message.links).toEqual([{ url: "https://example.com" }]);
  });

  it("preserves App Clip checkout URLs as text and links", () => {
    const adapter = createTestAdapter();
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");
    const payload = createMessageReceivedPayload();
    payload.data.parts = [
      {
        type: "app_clip",
        value: "https://checkout.linqapp.com/session/test",
        title: "Example merchant",
        description: "AED 10.00",
        image_url: "https://cdn.linqapp.com/app-clips/test.png",
      },
    ];

    const message = adapter.parseMessage(payload.data);

    expect(message.text).toBe("https://checkout.linqapp.com/session/test");
    expect(message.links).toEqual([{ url: "https://checkout.linqapp.com/session/test" }]);
    expect(message.raw).toBe(payload.data);
  });

  it("normalizes media parts as attachments", () => {
    const adapter = createTestAdapter();
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");
    const payload = createMessageReceivedPayload();
    payload.data.parts = [
      {
        id: "006a4826-7700-45e3-8796-39a7e26137e6",
        url: "https://cdn.linqapp.com/attachments/test/IMG_3389.png",
        type: "media",
        filename: "IMG_3389.png",
        mime_type: "image/png",
        size_bytes: 58500,
      },
    ];

    const message = adapter.parseMessage(payload.data);

    expect(message.text).toBe("[image attachment: IMG_3389.png]");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({
      type: "image",
      name: "IMG_3389.png",
      mimeType: "image/png",
      size: 58500,
      fetchMetadata: {
        attachmentId: "006a4826-7700-45e3-8796-39a7e26137e6",
      },
    });
    expect(message.attachments[0]?.url).toBeUndefined();
    expect(message.attachments[0]?.fetchData).toEqual(expect.any(Function));
  });

  it("normalizes native and attached audio through the same stable media contract", () => {
    const adapter = createTestAdapter();
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");
    const payload = createMessageReceivedPayload();
    const parts = [
      {
        id: "006a4826-7700-45e3-8796-39a7e26137e6",
        url: "https://cdn.linqapp.com/voice-memos/test/memo.m4a?signature=native",
        type: "media" as const,
        filename: "memo.m4a",
        mime_type: "audio/x-m4a",
        size_bytes: 58500,
      },
      {
        id: "106a4826-7700-45e3-8796-39a7e26137e6",
        url: "https://cdn.linqapp.com/attachments/test/audio.m4a?signature=attached",
        type: "media" as const,
        filename: "audio.m4a",
        mime_type: "audio/x-m4a",
        size_bytes: 58500,
      },
    ];

    const normalized = parts.map((part) => {
      payload.data.parts = [part];
      return adapter.parseMessage(payload.data).attachments[0];
    });

    expect(normalized).toEqual([
      expect.objectContaining({
        type: "audio",
        name: "memo.m4a",
        mimeType: "audio/x-m4a",
        size: 58500,
        fetchMetadata: {
          attachmentId: "006a4826-7700-45e3-8796-39a7e26137e6",
        },
      }),
      expect.objectContaining({
        type: "audio",
        name: "audio.m4a",
        mimeType: "audio/x-m4a",
        size: 58500,
        fetchMetadata: {
          attachmentId: "106a4826-7700-45e3-8796-39a7e26137e6",
        },
      }),
    ]);
    expect(normalized.every((attachment) => attachment?.url === undefined)).toBe(true);
  });

  it("preserves Linq reply metadata on raw messages", () => {
    const adapter = createTestAdapter();
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");
    const payload = createMessageReceivedPayload();
    payload.data.reply_to = {
      message_id: "9135965d-42ed-43bc-a1f5-793426b1aefd",
      part_index: 0,
    };

    const message = adapter.parseMessage(payload.data);

    expect(message.text).toBe("hi");
    expect((message.raw as LinqAPIV3.MessageEventV2).reply_to).toEqual({
      message_id: "9135965d-42ed-43bc-a1f5-793426b1aefd",
      part_index: 0,
    });
  });

  it("does not infer an edit from a retrieved message updated_at change", () => {
    const adapter = createTestAdapter();
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");

    const rawMessage: LinqAPIV3.Message = {
      id: "retrieved-message-id",
      chat_id: "chat-123",
      created_at: "2026-05-08T16:21:12.499Z",
      updated_at: "2026-05-08T16:22:12.499Z",
      is_delivered: true,
      delivery_status: "delivered",
      is_from_me: false,
      is_read: true,
      parts: [{ type: "text", value: "edited text", reactions: null }],
      from_handle: {
        id: "user-id",
        handle: "+15550002000",
        joined_at: "2026-04-17T17:26:38.725846Z",
        service: "iMessage",
      },
    };

    const message = adapter.parseMessage(rawMessage);

    expect(message.text).toBe("edited text");
    expect(message.metadata.edited).toBe(false);
    expect(message.metadata.editedAt).toBeUndefined();
  });
});

describe("LinqAdapter outbound media", () => {
  it("forwards a public HTTPS attachment as a media part by URL", async () => {
    const adapter = createTestAdapter();
    const send = vi.fn().mockResolvedValue(createSendResponse());
    const create = vi.fn();
    (
      adapter as unknown as {
        apiClient: {
          chats: { messages: { send: typeof send } };
          attachments: { create: typeof create };
        };
      }
    ).apiClient = {
      chats: { messages: { send } },
      attachments: { create },
    };
    vi.spyOn(adapter, "decodeThreadId").mockReturnValue({ chatId: "chat-123" });
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      await adapter.postMessage("linq:chat-123", {
        markdown: "check this out",
        attachments: [
          { type: "image", url: "https://cdn.linqapp.com/photo.jpg", mimeType: "image/jpeg" },
        ],
      });

      expect(create).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith("chat-123", {
        message: {
          idempotency_key: expect.any(String),
          parts: [
            { type: "text", value: "check this out" },
            { type: "media", url: "https://cdn.linqapp.com/photo.jpg" },
          ],
        },
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("pre-uploads binary attachment data and sends it by attachment_id", async () => {
    const adapter = createTestAdapter();
    const send = vi.fn().mockResolvedValue(createSendResponse());
    const create = vi.fn().mockResolvedValue({
      attachment_id: "att-789",
      upload_url: "https://uploads.linqapp.com/put/att-789",
      http_method: "PUT",
      required_headers: { "content-type": "image/png" },
      download_url: "https://cdn.linqapp.com/att-789.png",
      expires_at: "2026-06-14T00:15:00.000Z",
    });
    (
      adapter as unknown as {
        apiClient: {
          chats: { messages: { send: typeof send } };
          attachments: { create: typeof create };
        };
      }
    ).apiClient = {
      chats: { messages: { send } },
      attachments: { create },
    };
    vi.spyOn(adapter, "decodeThreadId").mockReturnValue({ chatId: "chat-123" });
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    try {
      await adapter.postMessage("linq:chat-123", {
        markdown: "here",
        attachments: [
          { type: "image", name: "pic.png", mimeType: "image/png", data: Buffer.from("img-bytes") },
        ],
      });

      expect(create).toHaveBeenCalledWith(
        {
          filename: "pic.png",
          content_type: "image/png",
          size_bytes: Buffer.from("img-bytes").byteLength,
        },
        { maxRetries: 0 },
      );
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://uploads.linqapp.com/put/att-789",
        expect.objectContaining({
          method: "PUT",
          headers: { "content-type": "image/png" },
          redirect: "error",
        }),
      );
      expect(send).toHaveBeenCalledWith("chat-123", {
        message: {
          idempotency_key: expect.any(String),
          parts: [
            { type: "text", value: "here" },
            { type: "media", attachment_id: "att-789" },
          ],
        },
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("sends a media-only message when there is no text", async () => {
    const adapter = createTestAdapter();
    const send = vi.fn().mockResolvedValue(createSendResponse());
    (
      adapter as unknown as { apiClient: { chats: { messages: { send: typeof send } } } }
    ).apiClient = {
      chats: { messages: { send } },
    };
    vi.spyOn(adapter, "decodeThreadId").mockReturnValue({ chatId: "chat-123" });
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");

    await adapter.postMessage("linq:chat-123", {
      markdown: "",
      attachments: [
        { type: "image", url: "https://cdn.linqapp.com/photo.jpg", mimeType: "image/jpeg" },
      ],
    });

    expect(send).toHaveBeenCalledWith("chat-123", {
      message: {
        idempotency_key: expect.any(String),
        parts: [{ type: "media", url: "https://cdn.linqapp.com/photo.jpg" }],
      },
    });
  });

  it("rejects an oversized URL-only attachment without fetching or calling Linq", async () => {
    const adapter = createTestAdapter();
    const send = vi.fn().mockResolvedValue(createSendResponse());
    const create = vi.fn();
    (
      adapter as unknown as {
        apiClient: {
          chats: { messages: { send: typeof send } };
          attachments: { create: typeof create };
        };
      }
    ).apiClient = {
      chats: { messages: { send } },
      attachments: { create },
    };
    vi.spyOn(adapter, "decodeThreadId").mockReturnValue({ chatId: "chat-123" });
    vi.spyOn(adapter, "encodeThreadId").mockReturnValue("linq:chat-123");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      await expect(
        adapter.postMessage("linq:chat-123", {
          markdown: "",
          attachments: [
            {
              type: "video",
              url: "https://cdn.linqapp.com/clip.mp4",
              mimeType: "video/mp4",
              size: 25 * 1024 * 1024,
            },
          ],
        }),
      ).rejects.toThrow("requires data or fetchData for pre-upload");

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("LinqAdapter.rehydrateAttachment", () => {
  it("resolves a fresh URL from the stable ID after serialization", async () => {
    const adapter = createTestAdapter();
    const retrieve = vi.fn().mockResolvedValue({
      id: "006a4826-7700-45e3-8796-39a7e26137e6",
      filename: "photo.jpg",
      content_type: "image/jpeg",
      size_bytes: 3,
      status: "complete",
      created_at: "2026-07-31T00:00:00Z",
      download_url: "https://cdn.linqapp.com/photo.jpg?signature=fresh",
    });
    (
      adapter as unknown as {
        apiClient: { attachments: { retrieve: typeof retrieve } };
      }
    ).apiClient = { attachments: { retrieve } };
    const rehydrated = adapter.rehydrateAttachment({
      type: "image",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      size: 3,
      fetchMetadata: {
        attachmentId: "006a4826-7700-45e3-8796-39a7e26137e6",
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([7, 8, 9]), {
        status: 200,
        headers: {
          "content-length": "3",
          "content-type": "image/jpeg",
        },
      }),
    );

    try {
      const data = await rehydrated.fetchData?.();

      expect(retrieve).toHaveBeenCalledWith("006a4826-7700-45e3-8796-39a7e26137e6", {
        signal: expect.any(AbortSignal),
        timeout: 30_000,
      });
      expect(fetchSpy).toHaveBeenCalledWith("https://cdn.linqapp.com/photo.jpg?signature=fresh", {
        redirect: "manual",
        signal: expect.any(AbortSignal),
      });
      expect(data).toEqual(Buffer.from([7, 8, 9]));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns the attachment unchanged when there is no URL to rebuild from", () => {
    const adapter = createTestAdapter();
    const attachment = { type: "file" as const, name: "mystery.bin" };

    expect(adapter.rehydrateAttachment(attachment)).toBe(attachment);
  });
});

describe("LinqAdapter.channelIdFromThreadId", () => {
  it("uses the Linq thread ID as the channel ID", () => {
    const adapter = createTestAdapter();

    expect(adapter.channelIdFromThreadId("linq:chat-123")).toBe("linq:chat-123");
  });
});

describe("LinqAdapter thread IDs", () => {
  it("encodes a stable thread ID without group/dm metadata", () => {
    const adapter = createTestAdapter();

    expect(adapter.encodeThreadId({ chatId: "chat-123" })).toBe("linq:chat-123");
    expect(adapter.encodeThreadId({ chatId: "chat-123", isGroup: true })).toBe("linq:chat-123");
    expect(adapter.encodeThreadId({ chatId: "chat-123", isGroup: false })).toBe("linq:chat-123");
  });

  it("round-trips encoded thread IDs", () => {
    const adapter = createTestAdapter();

    expect(adapter.decodeThreadId(adapter.encodeThreadId({ chatId: "chat-123" }))).toMatchObject({
      chatId: "chat-123",
    });
  });

  it("remembers group/dm identity seen while encoding", () => {
    const adapter = createTestAdapter();

    adapter.encodeThreadId({ chatId: "chat-group", isGroup: true });
    adapter.encodeThreadId({ chatId: "chat-dm", isGroup: false });

    expect(adapter.decodeThreadId("linq:chat-group")).toEqual({
      chatId: "chat-group",
      isGroup: true,
    });
    expect(adapter.decodeThreadId("linq:chat-dm")).toEqual({ chatId: "chat-dm", isGroup: false });
  });

  it("decodes legacy group/dm thread IDs", () => {
    const adapter = createTestAdapter();

    expect(adapter.decodeThreadId("linq:chat-123:group")).toEqual({
      chatId: "chat-123",
      isGroup: true,
    });
    expect(adapter.decodeThreadId("linq:chat-123:dm")).toEqual({
      chatId: "chat-123",
      isGroup: false,
    });
  });

  it("rejects malformed thread IDs", () => {
    const adapter = createTestAdapter();

    expect(() => adapter.decodeThreadId("slack:chat-123")).toThrow("Invalid Linq thread ID");
    expect(() => adapter.decodeThreadId("linq:")).toThrow("Invalid Linq thread ID");
    expect(() => adapter.decodeThreadId("linq:chat-123:nonsense")).toThrow(
      "Invalid Linq thread ID",
    );
  });
});

describe("LinqAdapter.isDM", () => {
  it("treats unknown chats as non-DMs until identity is known", () => {
    const adapter = createTestAdapter();

    expect(adapter.isDM("linq:chat-123")).toBe(false);
  });

  it("detects DMs and groups learned from encoding", () => {
    const adapter = createTestAdapter();

    adapter.encodeThreadId({ chatId: "chat-group", isGroup: true });
    adapter.encodeThreadId({ chatId: "chat-dm", isGroup: false });

    expect(adapter.isDM("linq:chat-group")).toBe(false);
    expect(adapter.isDM("linq:chat-dm")).toBe(true);
  });
});

function createTestAdapter() {
  return createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
}

function createSendResponse(): Awaited<ReturnType<LinqAPIV3["chats"]["messages"]["send"]>> {
  return {
    chat_id: "chat-123",
    message: {
      id: "outbound-message-id",
      created_at: "2026-06-14T00:00:00.000Z",
      delivery_status: "queued",
      is_read: false,
      parts: [{ type: "text", value: "ok", reactions: null }],
      sent_at: null,
    },
  };
}

function createSignedRequest(
  payload: unknown,
  overrides: { signature?: string; timestamp?: string } = {},
): Request {
  const body = JSON.stringify(payload);
  return createStandardRequest(body, overrides);
}

function createStandardRequest(
  body: string,
  overrides: { signature?: string; timestamp?: string } = {},
): Request {
  const timestamp = overrides.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const webhookId = "webhook-test-id";
  const signature =
    overrides.signature ??
    `v1,${createHmac("sha256", SIGNING_KEY)
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

function createMessageReceivedPayload(): LinqMessageReceivedWebhookEvent {
  return {
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "message.received",
    event_id: "ff654877-df18-4384-b3aa-928212533477",
    created_at: "2026-05-08T16:21:12.793119775Z",
    trace_id: "5619088b713532654fd0e6023b8c98e1",
    partner_id: "7ac8224b-c41a-54fb-96ed-e28a94f97ff6",
    data: {
      id: "e230c922-3e96-4376-9332-67b644d11237",
      chat: {
        id: "3caaf1a0-ef9f-46e0-8c22-31e82c8514dc",
        is_group: false,
        owner_handle: {
          id: "80e94fbc-df40-4421-807c-71f9ee6b6390",
          is_me: true,
          handle: "+15550001000",
          status: "active",
          left_at: null,
          service: "iMessage",
          joined_at: "2026-04-17T17:26:38.725846Z",
        },
        health_status: {
          status: "HEALTHY",
          doc_url: "https://docs.linqapp.com/guides/chats/chat-health#healthy",
          updated_at: "2026-04-25T03:51:55.282Z",
        },
      },
      parts: [
        {
          type: "text",
          value: "hi",
          text_decorations: null,
        },
      ],
      effect: null,
      read_at: null,
      sent_at: "2026-05-08T16:21:12.499Z",
      service: "iMessage",
      reply_to: null,
      direction: "inbound",
      delivered_at: null,
      sender_handle: {
        id: "1fcfb06a-99d6-4df5-9e26-d8a5b1be24ed",
        is_me: false,
        handle: "+15550002000",
        status: "active",
        left_at: null,
        service: "iMessage",
        joined_at: "2026-04-17T17:26:38.725846Z",
      },
      idempotency_key: null,
      preferred_service: null,
    },
  };
}

function createReactionPayload(
  eventType: "reaction.added" | "reaction.removed" = "reaction.added",
  data: Partial<LinqReactionWebhookData> = {},
): LinqReactionWebhookEvent {
  return {
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: eventType,
    event_id: "0b9a37e2-66cf-4f4f-9a3f-1f0a2b8e8d11",
    created_at: "2026-05-08T16:25:00.000000000Z",
    trace_id: "f3c1a76b8d2e4f50a1b2c3d4e5f60718",
    partner_id: "7ac8224b-c41a-54fb-96ed-e28a94f97ff6",
    data: {
      is_from_me: false,
      reaction_type: "like",
      chat_id: "3caaf1a0-ef9f-46e0-8c22-31e82c8514dc",
      message_id: "e230c922-3e96-4376-9332-67b644d11237",
      part_index: 0,
      reacted_at: "2026-05-08T16:25:00.000Z",
      service: "iMessage",
      from_handle: {
        id: "1fcfb06a-99d6-4df5-9e26-d8a5b1be24ed",
        is_me: false,
        handle: "+15550002000",
        status: "active",
        left_at: null,
        service: "iMessage",
        joined_at: "2026-04-17T17:26:38.725846Z",
      },
      ...data,
    },
  };
}
