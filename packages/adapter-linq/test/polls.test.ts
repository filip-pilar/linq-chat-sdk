import { createHmac } from "node:crypto";

import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import { Chat } from "chat";
import type { ChatInstance, Logger, StateAdapter } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLinqAdapter, type LinqAdapter } from "../src/index.js";
import pollFixtures from "./fixtures/poll-events-2026-02-03.json";

const CHAT_ID = "30000000-0000-0000-0000-000000000001";
const THREAD_ID = `linq:${CHAT_ID}`;
const MESSAGE_ID = "20000000-0000-0000-0000-000000000001";
const OPTION_ID = "50000000-0000-0000-0000-000000000001";
const SIGNING_KEY = "test_linq_webhook_secret";
const SIGNING_SECRET = `whsec_${Buffer.from(SIGNING_KEY).toString("base64")}`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Linq conversation polls", () => {
  it("creates with generated or supplied idempotency and returns an immutable snapshot", async () => {
    const { adapter, createPoll } = await createPollHarness();
    const options = ["Tacos", "Sushi"];

    const generated = await adapter.conversation(THREAD_ID).polls.create({ options });
    const suppliedKey = " logical-poll-1 ";
    const supplied = await adapter
      .conversation(THREAD_ID)
      .polls.create({ options, idempotencyKey: suppliedKey });

    expect(createPoll.mock.calls[0]).toEqual([
      CHAT_ID,
      {
        poll: {
          options: [{ text: "Tacos" }, { text: "Sushi" }],
          idempotency_key: expect.any(String),
        },
      },
    ]);
    expect(createPoll.mock.calls[1]?.[1]).toEqual({
      poll: {
        options: [{ text: "Tacos" }, { text: "Sushi" }],
        idempotency_key: suppliedKey,
      },
    });
    expect(new Set(createPoll.mock.calls.map((call) => call[1].poll.idempotency_key)).size).toBe(2);
    expect(generated).toMatchObject({
      threadId: THREAD_ID,
      messageId: MESSAGE_ID,
      createdAt: "2026-07-08T17:35:00.123456789Z",
      updatedAt: "2026-07-08T17:36:00Z",
      totalVoters: 1,
      options: [
        expect.objectContaining({
          optionId: OPTION_ID,
          text: "Tacos",
          canBeEdited: true,
          voters: [{ handle: "+14155550100", votedAt: "2026-07-08T17:35:30Z" }],
        }),
      ],
    });
    expect(supplied).toEqual(generated);
    expect(options).toEqual(["Tacos", "Sushi"]);
    expect(Object.isFrozen(generated)).toBe(true);
    expect(Object.isFrozen(generated.options)).toBe(true);
    expect(Object.isFrozen(generated.options[0]?.voters)).toBe(true);
    expect(Object.isFrozen(generated.raw)).toBe(true);
  });

  it("uses exact no-retry write operations and a normal safe retrieve", async () => {
    const { adapter, addOptions, retrievePoll, vote } = await createPollHarness();
    const polls = adapter.conversation(THREAD_ID).polls;

    await polls.addOptions(MESSAGE_ID, ["Pizza"]);
    await polls.vote(MESSAGE_ID, { optionId: OPTION_ID, operation: "add" });
    await polls.vote(MESSAGE_ID, { optionId: OPTION_ID, operation: "remove" });
    await polls.retrieve(MESSAGE_ID);

    expect(addOptions).toHaveBeenCalledWith(
      MESSAGE_ID,
      { options: [{ text: "Pizza" }] },
      { maxRetries: 0 },
    );
    expect(vote.mock.calls).toEqual([
      [MESSAGE_ID, { option_id: OPTION_ID, operation: "add" }, { maxRetries: 0 }],
      [MESSAGE_ID, { option_id: OPTION_ID, operation: "remove" }, { maxRetries: 0 }],
    ]);
    expect(retrievePoll).toHaveBeenCalledWith(MESSAGE_ID);
  });

  it("reuses one generated key across SDK retries and one lazy credential snapshot", async () => {
    const bodies: Array<{ poll: { idempotency_key: string } }> = [];
    const credentials = vi.fn().mockResolvedValue({ apiKey: "rotating-poll-key" });
    let attempt = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { poll: { idempotency_key: string } });
      attempt += 1;
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: { message: "retry" } }), {
          status: 500,
          headers: { "content-type": "application/json", "retry-after-ms": "0" },
        });
      }
      return new Response(JSON.stringify(pollEnvelope()), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });
    const adapter = createLinqAdapter({
      baseURL: "https://poll-retry.example.test",
      credentials,
      webhookVerifier: () => true,
    });
    const chat = new Chat({
      adapters: { linq: adapter },
      logger: "silent",
      state: { connect: vi.fn(), disconnect: vi.fn() } as unknown as StateAdapter,
      userName: "poll-retry-test",
    });
    await chat.initialize();

    await adapter.conversation(THREAD_ID).polls.create({ options: ["A", "B"] });

    expect(credentials).toHaveBeenCalledOnce();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.poll.idempotency_key).toBe(bodies[1]?.poll.idempotency_key);
  });

  it.each([
    ["create", { options: [] }],
    ["create", { options: ["one"] }],
    ["create", { options: ["one", " "] }],
    ["create", { options: ["one", "two"], idempotencyKey: "" }],
    ["addOptions", []],
    ["addOptions", [""]],
    ["vote", { optionId: "not-a-uuid", operation: "add" }],
    ["vote", { optionId: OPTION_ID, operation: "replace" }],
    ["retrieve", "not-a-uuid"],
  ] as const)("rejects invalid %s input before provider I/O", async (operation, input) => {
    const harness = await createPollHarness();
    const polls = harness.adapter.conversation(THREAD_ID).polls;
    const call =
      operation === "create"
        ? polls.create(input as never)
        : operation === "addOptions"
          ? polls.addOptions(MESSAGE_ID, input as never)
          : operation === "vote"
            ? polls.vote(MESSAGE_ID, input as never)
            : polls.retrieve(input as string);

    await expect(call).rejects.toBeInstanceOf(ValidationError);
    for (const providerCall of harness.providerIO) expect(providerCall).not.toHaveBeenCalled();
  });

  it("rejects invalid poll input before resolving lazy credentials", async () => {
    const credentials = vi.fn().mockResolvedValue({ apiKey: "unused-key" });
    const adapter = createLinqAdapter({ credentials, webhookVerifier: () => true });
    const chat = new Chat({
      adapters: { linq: adapter },
      logger: "silent",
      state: { connect: vi.fn(), disconnect: vi.fn() } as unknown as StateAdapter,
      userName: "poll-validation-test",
    });
    await chat.initialize();

    await expect(
      adapter.conversation(THREAD_ID).polls.create({ options: ["only one"] }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(credentials).not.toHaveBeenCalled();
  });

  it("rejects pending, foreign, malformed, cross-chat, and malformed provider identities", async () => {
    const harness = await createPollHarness();
    expect(() => harness.adapter.conversation("linq:pending:+15550000000")).toThrow(
      ValidationError,
    );
    expect(() => harness.adapter.conversation(`other:${CHAT_ID}`)).toThrow(ValidationError);
    expect(() => harness.adapter.conversation("linq:not-a-uuid")).toThrow(ValidationError);

    for (const mutation of [
      { chat_id: "90000000-0000-0000-0000-000000000009" },
      { message_id: null },
      { created_at: "not-a-date" },
      { poll: { options: [], total_voters: -1 } },
    ]) {
      harness.createPoll.mockResolvedValueOnce({ ...pollEnvelope(), ...mutation });
      await expect(
        harness.adapter.conversation(THREAD_ID).polls.create({ options: ["A", "B"] }),
      ).rejects.toBeInstanceOf(AdapterError);
    }
  });

  it.each([
    [400, ValidationError],
    [401, AuthenticationError],
    [403, PermissionError],
    [404, ResourceNotFoundError],
    [429, AdapterRateLimitError],
    [500, AdapterError],
  ] as const)("translates poll provider failures with status %s", async (status, ErrorType) => {
    const harness = await createPollHarness();
    harness.retrievePoll.mockRejectedValueOnce(
      Object.assign(new Error("provider failure"), { status }),
    );

    await expect(
      harness.adapter.conversation(THREAD_ID).polls.retrieve(MESSAGE_ID),
    ).rejects.toBeInstanceOf(ErrorType);
  });
});

describe("authenticated poll event observations", () => {
  it.each(pollFixtures)(
    "dispatches typed $event_type through exact named and generic handlers",
    async (fixture) => {
      const context = await createWebhookContext();
      const named = vi.fn();
      const generic = vi.fn();
      const tasks: Promise<unknown>[] = [];
      context.adapter.onLinqEvent(fixture.event_type as never, named);
      context.adapter.onLinqEvent(generic);

      const response = await context.adapter.handleWebhook(createStandardRequest(fixture), {
        waitUntil: (task) => tasks.push(task),
      });
      await Promise.all(tasks);

      expect(response.status).toBe(200);
      expect(named).toHaveBeenCalledOnce();
      expect(generic).toHaveBeenCalledOnce();
      expect(named).toHaveBeenCalledWith(
        expect.objectContaining({ type: fixture.event_type, rawEvent: fixture }),
      );
      expect(Object.isFrozen(named.mock.calls[0]?.[0].data)).toBe(true);
      expect(context.processMessage).not.toHaveBeenCalled();
      expect(context.processReaction).not.toHaveBeenCalled();
    },
  );

  it.each(pollFixtures)("keeps malformed $event_type generic-only and deduped", async (fixture) => {
    const context = await createWebhookContext();
    const named = vi.fn();
    const generic = vi.fn();
    const malformed = structuredClone(fixture) as Record<string, unknown>;
    malformed.data = { malformed: true, original: fixture.data };
    context.adapter.onLinqEvent(fixture.event_type as never, named);
    context.adapter.onLinqEvent(generic);

    const first = await context.adapter.handleWebhook(createStandardRequest(malformed));
    const duplicate = await context.adapter.handleWebhook(createStandardRequest(malformed));

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(named).not.toHaveBeenCalled();
    expect(generic).toHaveBeenCalledOnce();
    expect(generic).toHaveBeenCalledWith(
      expect.objectContaining({
        type: fixture.event_type,
        data: malformed.data,
        rawEvent: malformed,
      }),
    );
    expect(context.processMessage).not.toHaveBeenCalled();
    expect(context.processReaction).not.toHaveBeenCalled();
  });

  it("uses the same typed/lossless path for trusted forwarding and isolates callbacks", async () => {
    const adapter = createLinqAdapter({ apiKey: "test-key", webhookVerifier: () => true });
    const context = await createWebhookContext(adapter);
    const failure = new Error("poll callback failed");
    const failed = vi.fn(async () => {
      throw failure;
    });
    const sibling = vi.fn();
    const fixture = pollFixtures[0]!;
    adapter.onLinqEvent("poll.received", failed);
    adapter.onLinqEvent("poll.received", sibling);

    const response = await adapter.handleWebhook(
      new Request("https://forwarder.example.test/linq", {
        method: "POST",
        body: JSON.stringify(fixture),
      }),
    );
    await vi.waitFor(() => expect(sibling).toHaveBeenCalledOnce());

    expect(response.status).toBe(200);
    expect(failed).toHaveBeenCalledOnce();
    expect(context.logger.error).toHaveBeenCalledWith("Linq event handler failed", {
      error: failure,
      eventType: "poll.received",
    });
  });
});

async function createPollHarness(): Promise<{
  adapter: LinqAdapter;
  createPoll: ReturnType<typeof vi.fn>;
  addOptions: ReturnType<typeof vi.fn>;
  vote: ReturnType<typeof vi.fn>;
  retrievePoll: ReturnType<typeof vi.fn>;
  providerIO: ReturnType<typeof vi.fn>[];
}> {
  const adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: SIGNING_SECRET });
  const createPoll = vi.fn().mockResolvedValue(pollEnvelope());
  const addOptions = vi.fn().mockResolvedValue(pollEnvelope());
  const vote = vi.fn().mockResolvedValue(pollEnvelope());
  const retrievePoll = vi.fn().mockResolvedValue(pollEnvelope());
  Object.assign(adapter.client.chats.polls, { create: createPoll });
  Object.assign(adapter.client.messages.poll, { addOptions, retrieve: retrievePoll, vote });
  const state = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as StateAdapter;
  const chat = new Chat({
    adapters: { linq: adapter },
    logger: "silent",
    state,
    userName: "poll-test",
  });
  await chat.initialize();
  return {
    adapter,
    createPoll,
    addOptions,
    vote,
    retrievePoll,
    providerIO: [createPoll, addOptions, vote, retrievePoll],
  };
}

function pollEnvelope() {
  return {
    chat_id: CHAT_ID,
    created_at: "2026-07-08T17:35:00.123456789Z",
    message_id: MESSAGE_ID,
    poll: {
      options: [
        {
          can_be_edited: true,
          creator_handle: {
            id: "40000000-0000-0000-0000-000000000002",
            handle: "+14155550100",
            joined_at: "2026-07-01T00:00:00Z",
            service: "iMessage",
            is_me: false,
            left_at: null,
            status: "active",
          },
          option_id: OPTION_ID,
          text: "Tacos",
          voters: [{ handle: "+14155550100", voted_at: "2026-07-08T17:35:30Z" }],
        },
      ],
      total_voters: 1,
    },
    reactions: [],
    updated_at: "2026-07-08T17:36:00Z",
  };
}

async function createWebhookContext(
  adapter = createLinqAdapter({ apiKey: "test-key", signingSecret: SIGNING_SECRET }),
): Promise<{
  adapter: LinqAdapter;
  logger: Logger & { error: ReturnType<typeof vi.fn> };
  processMessage: ReturnType<typeof vi.fn>;
  processReaction: ReturnType<typeof vi.fn>;
}> {
  const claimed = new Set<string>();
  const logger = silentLogger();
  const processMessage = vi.fn();
  const processReaction = vi.fn();
  await adapter.initialize({
    getLogger: () => logger,
    getState: () =>
      ({
        setIfNotExists: vi.fn(async (key: string) => {
          if (claimed.has(key)) return false;
          claimed.add(key);
          return true;
        }),
      }) as unknown as StateAdapter,
    processMessage,
    processReaction,
  } as unknown as ChatInstance);
  return { adapter, logger, processMessage, processReaction };
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

function silentLogger(): Logger & { error: ReturnType<typeof vi.fn> } {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return logger;
}
