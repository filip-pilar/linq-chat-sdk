import { LinqAPIV3 } from "@linqapp/sdk";
import { describe, expect, it, vi } from "vitest";

import { createExactLineSmokeSubscription, sendExactLineText } from "../src/smoke-operations.js";

const FROM = "+12025550111";
const TO = "+12025550112";

describe("typed Linq smoke operations", () => {
  it("uses fixed-line chat creation with SDK-supported fields and idempotency", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(chatResponse(FROM, TO));
    const client = clientWith(fetchMock);

    const result = await sendExactLineText(client, { from: FROM, to: TO, text: "hello" });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(String(url)).toMatch(/\/v3\/chats$/);
    expect(body).toMatchObject({
      from: FROM,
      to: [TO],
      message: {
        parts: [{ type: "text", value: "hello" }],
      },
    });
    expect(body).not.toHaveProperty("exclude_from");
    expect(body.message).toMatchObject({ idempotency_key: expect.any(String) });
    expect(result).toMatchObject({
      chatId: "chat-1",
      from: FROM,
      messageId: "message-1",
      service: "iMessage",
    });
  });

  it("fails closed when the provider response does not confirm the selected line", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(chatResponse("+12025550199", TO));
    const client = clientWith(fetchMock);

    await expect(sendExactLineText(client, { from: FROM, to: TO, text: "hello" })).rejects.toThrow(
      "Linq exact-line smoke postcondition failed",
    );
  });

  it("creates a subscription filtered only to the selected line", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(subscriptionResponse());
    const client = clientWith(fetchMock);

    await createExactLineSmokeSubscription(client, "https://example.test/linq", FROM);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(String(url)).toMatch(/\/v3\/webhook-subscriptions$/);
    expect(body).toEqual({
      target_url: "https://example.test/linq",
      subscribed_events: ["message.received", "message.sent"],
      phone_numbers: [FROM],
    });
  });
});

function clientWith(fetchMock: typeof fetch): LinqAPIV3 {
  return new LinqAPIV3({
    apiKey: "test-token",
    baseURL: "https://api.example.test",
    fetch: fetchMock,
    maxRetries: 0,
  });
}

function chatResponse(from: string, to: string): Response {
  return jsonResponse({
    chat: {
      id: "chat-1",
      display_name: null,
      handles: [
        {
          id: "handle-from",
          handle: from,
          is_me: true,
          joined_at: "2026-08-19T00:00:00Z",
          service: "iMessage",
          status: "active",
        },
        {
          id: "handle-to",
          handle: to,
          is_me: false,
          joined_at: "2026-08-19T00:00:00Z",
          service: "iMessage",
          status: "active",
        },
      ],
      health_status: {
        doc_url: "https://docs.example.test/health",
        status: "HEALTHY",
        updated_at: "2026-08-19T00:00:00Z",
      },
      is_group: false,
      message: {
        id: "message-1",
        created_at: "2026-08-19T00:00:00Z",
        delivery_status: "queued",
        is_read: false,
        parts: [{ reactions: [], type: "text", value: "hello" }],
        sent_at: "2026-08-19T00:00:00Z",
      },
      service: "iMessage",
    },
  });
}

function subscriptionResponse(): Response {
  return jsonResponse({
    id: "subscription-1",
    created_at: "2026-08-19T00:00:00Z",
    is_active: true,
    signing_secret: "whsec_test",
    subscribed_events: ["message.received", "message.sent"],
    target_url: "https://example.test/linq",
    updated_at: "2026-08-19T00:00:00Z",
    phone_numbers: [FROM],
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
