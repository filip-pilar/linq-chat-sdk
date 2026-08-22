import { createHmac } from "node:crypto";

import { Chat } from "chat";
import type { ChatInstance, Logger, StateAdapter } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter, type LinqAdapter } from "../src/index.js";
import startedFixture from "./fixtures/location-sharing-started-2026-02-03.json";
import stoppedFixture from "./fixtures/location-sharing-stopped-2026-02-03.json";

const SIGNING_KEY = "test_linq_webhook_secret";
const SIGNING_SECRET = `whsec_${Buffer.from(SIGNING_KEY).toString("base64")}`;
const EVENT_DEDUPE_TTL_MS = 60 * 60 * 1000;

describe("typed Linq location-sharing events", () => {
  it("normalizes current started consent-window facts and preserves raw input", async () => {
    const result = await createTestAdapter().verifyWebhook(createStandardRequest(startedFixture));

    expect(result).toMatchObject({
      ok: true,
      webhook: {
        kind: "location.sharing.started",
        locationSharing: {
          sharedBy: startedFixture.data.shared_by,
          sharedWith: startedFixture.data.shared_with,
          beganAt: startedFixture.data.began_at,
          endsAt: startedFixture.data.ends_at,
        },
        rawEvent: startedFixture,
      },
    });
    if (result.ok) {
      expect(Object.isFrozen(result.webhook.rawEvent)).toBe(true);
      expect(Object.isFrozen(result.webhook.rawEvent.data)).toBe(true);
    }
  });

  it("normalizes stopped participant facts without inventing coordinates or correlation", async () => {
    const adapter = createTestAdapter();
    const handler = vi.fn();
    const context = await createContext(adapter);
    adapter.onLinqEvent("location.sharing.stopped", handler);

    const response = await adapter.handleWebhook(createStandardRequest(stoppedFixture));

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith({
      type: "location.sharing.stopped",
      data: {
        sharedBy: stoppedFixture.data.shared_by,
        sharedWith: stoppedFixture.data.shared_with,
      },
      envelope: expect.objectContaining({ traceId: stoppedFixture.trace_id }),
      transport: expect.objectContaining({ scheme: "standard" }),
      rawEvent: stoppedFixture,
    });
    expect(handler.mock.calls[0]?.[0].data).not.toHaveProperty("coordinates");
    expect(handler.mock.calls[0]?.[0].data).not.toHaveProperty("requestId");
    expect(context.processMessage).not.toHaveBeenCalled();
    expect(context.processReaction).not.toHaveBeenCalled();
  });

  it("accepts omitted nullable start timestamps as explicit null observations", async () => {
    const payload = {
      ...startedFixture,
      event_id: "70000000-0000-4000-8000-000000000003",
      data: { shared_by: "+15550000001", shared_with: "+15550000002" },
    };
    const result = await createTestAdapter().verifyWebhook(createStandardRequest(payload));

    expect(result).toMatchObject({
      ok: true,
      webhook: {
        locationSharing: { beganAt: null, endsAt: null },
        rawEvent: payload,
      },
    });
  });

  it.each([
    [startedFixture, { shared_by: "" }],
    [startedFixture, { shared_with: null }],
    [startedFixture, { began_at: "not-a-date" }],
    [startedFixture, { began_at: "2026-08-20" }],
    [startedFixture, { ends_at: null }],
    [startedFixture, { ends_at: 42 }],
    [stoppedFixture, { shared_by: null }],
  ] as const)(
    "preserves malformed current location payloads losslessly",
    async (fixture, override) => {
      const payload = { ...fixture, data: { ...fixture.data, ...override } };

      await expect(
        createTestAdapter().verifyWebhook(createStandardRequest(payload)),
      ).resolves.toMatchObject({ ok: true, webhook: { kind: "unhandled", rawEvent: payload } });
    },
  );

  it("keeps future webhook versions authenticated, lossless, and unsupported", async () => {
    const payload = {
      ...startedFixture,
      webhook_version: "2099-01-01",
      data: { future_location_fact: { nested: [1, true, null] } },
    };
    const result = await createTestAdapter().verifyWebhook(createStandardRequest(payload));

    expect(result).toMatchObject({
      ok: true,
      webhook: {
        kind: "unsupported_version",
        envelope: { versionStatus: "future" },
        rawEvent: payload,
      },
    });
  });

  it("reuses atomic dedupe and does not enter standard message or reaction dispatch", async () => {
    const context = await createContext();
    const named = vi.fn();
    const all = vi.fn();
    context.adapter.onLinqEvent("location.sharing.started", named);
    context.adapter.onLinqEvent(all);

    const first = await context.adapter.handleWebhook(createStandardRequest(startedFixture));
    const duplicate = await context.adapter.handleWebhook(
      createStandardRequest(startedFixture, "duplicate-location-attempt"),
    );

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(context.setIfNotExists).toHaveBeenCalledWith(
      `dedupe:linq:event:${startedFixture.partner_id}:${startedFixture.event_id}`,
      true,
      EVENT_DEDUPE_TTL_MS,
    );
    expect(named).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(1);
    expect(context.processMessage).not.toHaveBeenCalled();
    expect(context.processReaction).not.toHaveBeenCalled();
  });

  it("dispatches through the public Chat SDK webhook route", async () => {
    const adapter = createTestAdapter();
    const handler = vi.fn();
    const tasks: Promise<unknown>[] = [];
    const state = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      setIfNotExists: vi.fn().mockResolvedValue(true),
    } as unknown as StateAdapter;
    const chat = new Chat({
      adapters: { linq: adapter },
      logger: "silent",
      state,
      userName: "linq-location-test",
    });
    adapter.onLinqEvent("location.sharing.started", handler);

    const response = await chat.webhooks.linq(createStandardRequest(startedFixture), {
      waitUntil: (task) => tasks.push(task),
    });
    await Promise.all(tasks);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "location.sharing.started",
        data: expect.objectContaining({ endsAt: startedFixture.data.ends_at }),
      }),
    );
  });
});

function createTestAdapter(): LinqAdapter {
  return createLinqAdapter({ apiKey: "test_linq_api_key", signingSecret: SIGNING_SECRET });
}

async function createContext(adapter = createTestAdapter()): Promise<{
  adapter: LinqAdapter;
  processMessage: ReturnType<typeof vi.fn>;
  processReaction: ReturnType<typeof vi.fn>;
  setIfNotExists: ReturnType<typeof vi.fn>;
}> {
  const claimed = new Set<string>();
  const setIfNotExists = vi.fn(async (key: string) => {
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  });
  const processMessage = vi.fn(async () => {});
  const processReaction = vi.fn();
  const logger = createLogger();
  const chat = {
    getLogger: () => logger,
    getState: () => ({ setIfNotExists }) as unknown as StateAdapter,
    processMessage,
    processReaction,
  } as unknown as ChatInstance;

  await adapter.initialize(chat);
  return { adapter, processMessage, processReaction, setIfNotExists };
}

function createLogger(): Logger {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return logger;
}

function createStandardRequest(payload: unknown, webhookId = "location-webhook-id"): Request {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
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
