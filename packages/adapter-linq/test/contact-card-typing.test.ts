import { createHmac } from "node:crypto";

import type { ChatInstance, StateAdapter } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLinqAdapter } from "../src/index.js";
import vcardFixture from "./fixtures/message-received-vcard-2026-02-03.json";

const SIGNING_KEY = "test_linq_webhook_secret";
const SIGNING_SECRET = `whsec_${Buffer.from(SIGNING_KEY).toString("base64")}`;
const VCARD = Buffer.from("BEGIN:VCARD\nVERSION:4.0\nFN:Jordan Lee\nTEL:+14155550123\nEND:VCARD\n");
const VCARD_PART = vcardFixture.data.parts[0]!;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("contact-card and typing compatibility", () => {
  it("exposes inbound text/vcard media through the standard secure file path", async () => {
    const adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: SIGNING_SECRET });
    const processMessage = vi.fn();
    const retrieveAttachment = vi.fn().mockResolvedValue({
      id: VCARD_PART.id,
      filename: VCARD_PART.filename,
      content_type: "text/vcard",
      size_bytes: VCARD.byteLength,
      download_url: "https://cdn.linqapp.com/attachments/Jordan-Lee.vcf?signature=fresh",
    });
    Object.assign(adapter.client.attachments, { retrieve: retrieveAttachment });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(VCARD, {
        headers: {
          "content-length": String(VCARD.byteLength),
          "content-type": "text/vcard",
        },
      }),
    );
    await adapter.initialize({
      getLogger: () => silentLogger(),
      getState: () =>
        ({ setIfNotExists: vi.fn().mockResolvedValue(true) }) as unknown as StateAdapter,
      processMessage,
      processReaction: vi.fn(),
    } as unknown as ChatInstance);

    const response = await adapter.handleWebhook(createStandardRequest(vcardFixture));
    const factory = processMessage.mock.calls[0]?.[2] as () => Promise<unknown>;
    const message = (await factory()) as {
      attachments: Array<{
        type: string;
        name: string;
        mimeType: string;
        fetchMetadata: { attachmentId: string };
        fetchData: () => Promise<Buffer>;
      }>;
    };
    const attachment = message.attachments[0]!;

    expect(response.status).toBe(200);
    expect(attachment).toMatchObject({
      type: "file",
      name: "Jordan-Lee.vcf",
      mimeType: "text/vcard",
      fetchMetadata: { attachmentId: VCARD_PART.id },
    });
    await expect(attachment.fetchData()).resolves.toEqual(VCARD);
    expect(retrieveAttachment).toHaveBeenCalledWith(VCARD_PART.id, {
      signal: expect.any(AbortSignal),
      timeout: 30_000,
    });

    const verified = await adapter.verifyWebhook(createStandardRequest(vcardFixture));
    expect(verified).toMatchObject({
      ok: true,
      webhook: {
        kind: "message.received",
        message: {
          attachments: [
            expect.objectContaining({
              id: VCARD_PART.id,
              filename: "Jordan-Lee.vcf",
              mimeType: "text/vcard",
            }),
          ],
        },
        rawEvent: vcardFixture,
      },
    });
    if (verified.ok) expect(Object.isFrozen(verified.webhook.rawEvent)).toBe(true);
  });

  it("preserves vCard identity through history and refresh", async () => {
    const adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: SIGNING_SECRET });
    const raw = retrievedVcardMessage();
    const list = vi.fn().mockResolvedValue({ messages: [raw], next_cursor: null });
    const retrieve = vi.fn().mockResolvedValue(raw);
    Object.assign(adapter.client.chats.messages, { list });
    Object.assign(adapter.client.messages, { retrieve });

    const history = await adapter.fetchMessages(`linq:${raw.chat_id}`);
    const refreshed = await adapter.fetchMessage(`linq:${raw.chat_id}`, raw.id);

    for (const message of [history.messages[0], refreshed]) {
      expect(message?.attachments[0]).toMatchObject({
        type: "file",
        name: "Jordan-Lee.vcf",
        mimeType: "text/vcard",
        fetchMetadata: { attachmentId: VCARD_PART.id },
      });
    }
    expect(history.messages[0]?.id).toBe(raw.id);
    expect(refreshed?.id).toBe(raw.id);
  });

  it.each(["chat.typing_indicator.started", "chat.typing_indicator.stopped"] as const)(
    "observes authenticated %s as exact named raw facts without a state machine",
    async (eventType) => {
      const adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: SIGNING_SECRET });
      const named = vi.fn();
      const generic = vi.fn();
      const processMessage = vi.fn();
      const payload = {
        ...vcardFixture,
        event_id: `typing-${eventType}`,
        event_type: eventType,
        data: { chat_id: vcardFixture.data.chat.id },
      };
      adapter.onLinqEvent(eventType, named);
      adapter.onLinqEvent(generic);
      await adapter.initialize({
        getLogger: () => silentLogger(),
        getState: () =>
          ({ setIfNotExists: vi.fn().mockResolvedValue(true) }) as unknown as StateAdapter,
        processMessage,
        processReaction: vi.fn(),
      } as unknown as ChatInstance);

      const response = await adapter.handleWebhook(createStandardRequest(payload));
      await vi.waitFor(() => expect(named).toHaveBeenCalledOnce());

      expect(response.status).toBe(200);
      expect(named).toHaveBeenCalledWith(
        expect.objectContaining({ type: eventType, data: payload.data, rawEvent: payload }),
      );
      expect(generic).toHaveBeenCalledOnce();
      expect(processMessage).not.toHaveBeenCalled();
    },
  );
});

function retrievedVcardMessage() {
  return {
    id: vcardFixture.data.id,
    chat_id: vcardFixture.data.chat.id,
    created_at: vcardFixture.data.sent_at,
    sent_at: vcardFixture.data.sent_at,
    is_from_me: false,
    from_handle: vcardFixture.data.sender_handle,
    parts: vcardFixture.data.parts,
  };
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
