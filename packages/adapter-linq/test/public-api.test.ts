import { LinqAPIV3 } from "@linqapp/sdk";
import type { AdapterPostableMessage, SentMessage, Thread } from "chat";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createLinqAdapter, linqMessage, LINQ_WEBHOOK_VERSION, LinqAdapter } from "../src/index.js";
import type {
  LinqAnyEvent,
  LinqAdapterConfig,
  LinqConversation,
  LinqEventMap,
  LinqFutureEvent,
  LinqGroupConversation,
  LinqGroupUpdateOptions,
  LinqKnownEventType,
  LinqLocationConversation,
  LinqLocationSharingStartedEventData,
  LinqLocationSharingStoppedEventData,
  LinqLocationSnapshot,
  LinqMessageFailedEventData,
  LinqMessageLifecycleEventData,
  LinqMessageEditedEventData,
  LinqMessageObservation,
  LinqMessageOptions,
  LinqMessageReceivedWebhookData,
  LinqRawMessage,
  LinqReactionObservation,
  LinqSharedLocation,
  LinqPostableMessage,
  LinqVoiceMemoResult,
  LinqVoiceMemoSource,
  LinqVerifiedUnhandledWebhook,
  LinqVerifiedWebhook,
  LinqWebhookVerificationResult,
} from "../src/index.js";

const API_KEY = "test_linq_api_key";
const BASE_URL = "https://sandbox.example.com/api/partner";
const SIGNING_SECRET = "test_linq_webhook_secret";

const config = {
  apiKey: API_KEY,
  baseURL: BASE_URL,
  signingSecret: SIGNING_SECRET,
} satisfies LinqAdapterConfig;

function assertClientCannotBeReassigned(adapter: LinqAdapter): void {
  // @ts-expect-error -- `client` is a read-only view of the internally used Linq client.
  adapter.client = new LinqAPIV3({ apiKey: "replacement" });
}

void assertClientCannotBeReassigned;

function assertVerifiedWebhookCannotBeConstructed(adapter: LinqAdapter): void {
  const structurallyComplete: Pick<
    LinqVerifiedUnhandledWebhook,
    "kind" | "envelope" | "transport" | "rawEvent"
  > = {
    kind: "unhandled",
    envelope: {
      provider: "linq",
      apiVersion: "v3",
      webhookVersion: LINQ_WEBHOOK_VERSION,
      versionStatus: "current",
      eventType: "message.delivered",
      eventId: "event-123",
      createdAt: "2026-08-02T12:00:00.000Z",
      traceId: "trace-123",
      partnerId: "partner-123",
    },
    transport: {
      scheme: "standard",
      webhookId: "webhook-123",
      timestamp: "1785672000",
    },
    rawEvent: {},
  };

  // @ts-expect-error -- only verifyWebhook() can supply the private verified brand.
  void adapter.dispatchVerifiedWebhook(structurallyComplete);
}

void assertVerifiedWebhookCannotBeConstructed;

function assertTypedEventRegistration(adapter: LinqAdapter): void {
  const unsubscribeMessage = adapter.onLinqEvent("message.received", (event) => {
    expectTypeOf(event.type).toEqualTypeOf<"message.received">();
    expectTypeOf(event.data).toEqualTypeOf<LinqMessageReceivedWebhookData>();
    expectTypeOf(event.data.parts).toEqualTypeOf<LinqAPIV3.MessageEventV2["parts"] | null>();
    expectTypeOf(event.rawEvent).not.toBeAny();
    expectTypeOf(event.data.reconciled_at).toEqualTypeOf<string | undefined>();
  });
  const unsubscribeLifecycle = adapter.onLinqEvent(
    ["message.delivered", "message.failed"] as const,
    (event) => {
      expectTypeOf(event).toEqualTypeOf<
        LinqEventMap["message.delivered"] | LinqEventMap["message.failed"]
      >();
      expectTypeOf(event.data).toEqualTypeOf<
        LinqMessageLifecycleEventData | LinqMessageFailedEventData
      >();
    },
  );
  adapter.onLinqEvent("message.sent", (event) => {
    expectTypeOf(event.data).toEqualTypeOf<LinqMessageLifecycleEventData>();
    expectTypeOf(event.data.providerMessageId).toBeString();
    expectTypeOf(event.envelope.traceId).toBeString();
  });
  adapter.onLinqEvent("message.failed", (event) => {
    expectTypeOf(event.data).toEqualTypeOf<LinqMessageFailedEventData>();
    expectTypeOf(event.data.code).toBeNumber();
    expectTypeOf(event.data.detailCode).toEqualTypeOf<number | null>();
  });
  adapter.onLinqEvent("message.edited", (event) => {
    expectTypeOf(event.data).toEqualTypeOf<LinqMessageEditedEventData>();
    expectTypeOf(event.data.providerMessageId).toBeString();
    expectTypeOf(event.data.partIndex).toBeNumber();
    expectTypeOf(event.data.editedAt).toBeString();
  });
  const unsubscribeAll = adapter.onLinqEvent((event) => {
    expectTypeOf(event).toEqualTypeOf<LinqAnyEvent>();
  });

  expectTypeOf(unsubscribeMessage).toEqualTypeOf<() => void>();
  expectTypeOf(unsubscribeLifecycle).toEqualTypeOf<() => void>();
  expectTypeOf(unsubscribeAll).toEqualTypeOf<() => void>();

  // @ts-expect-error -- named registrations use the checked-in current event inventory.
  adapter.onLinqEvent("future.provider_event", () => {});
}

void assertTypedEventRegistration;

function assertFidelityObservations(
  message: LinqMessageObservation,
  reaction: LinqReactionObservation,
  raw: LinqRawMessage,
): void {
  expectTypeOf(message.effect?.type).toEqualTypeOf<"screen" | "bubble" | null | undefined>();
  expectTypeOf(message.partObservations[0]?.raw).not.toBeAny();
  expectTypeOf(message.partObservations[0]?.reactions[0]?.sticker?.url).toEqualTypeOf<
    string | null | undefined
  >();
  expectTypeOf(reaction.sticker?.mimeType).toEqualTypeOf<string | null | undefined>();
  expectTypeOf(raw).not.toBeAny();
}

void assertFidelityObservations;

function assertLinqMessageErgonomics(
  thread: Thread,
  sent: SentMessage,
  content: AdapterPostableMessage,
  options: LinqMessageOptions,
): void {
  const direct = linqMessage("hello", { preferredService: "iMessage" });
  const variable = linqMessage(content, options);

  expectTypeOf(direct).toEqualTypeOf<LinqPostableMessage>();
  expectTypeOf(variable).toEqualTypeOf<LinqPostableMessage>();
  expectTypeOf(direct).toMatchTypeOf<AdapterPostableMessage>();
  expectTypeOf(thread.post(direct)).resolves.toMatchTypeOf<SentMessage>();
  expectTypeOf(thread.reply("message-id", variable)).resolves.toMatchTypeOf<SentMessage>();
  expectTypeOf(sent.edit(variable)).resolves.toMatchTypeOf<SentMessage>();

  // @ts-expect-error -- the helper exposes a read-only metadata snapshot.
  direct.linq.preferredService = "SMS";

  linqMessage("hello", {
    decorations: [
      { range: [0, 5], style: "underline" },
      { range: [0, 5], animation: "shake" },
    ],
  });
  linqMessage("hello", {
    decorations: [
      // @ts-expect-error -- decoration ranges are exactly two endpoints.
      { range: [0, 1, 2], style: "bold" },
    ],
  });
  linqMessage("hello", {
    decorations: [
      // @ts-expect-error -- decoration styles are a closed provider contract.
      { range: [0, 5], style: "sparkly" },
    ],
  });
  linqMessage("hello", {
    decorations: [
      // @ts-expect-error -- decoration animations are a closed provider contract.
      { range: [0, 5], animation: "spin" },
    ],
  });
  linqMessage("hello", {
    preferredService: "RCS",
    effect: { type: "bubble", name: "invisible" },
  });
  linqMessage("", { richLink: new URL("https://example.com/preview") });
  linqMessage("", {
    // @ts-expect-error -- rich links accept only strings or URL objects.
    richLink: 42,
  });
  linqMessage("hello", {
    // @ts-expect-error -- preferred service values are closed and case-sensitive.
    preferredService: "sms",
  });
  linqMessage("hello", {
    // @ts-expect-error -- screen and bubble effect names cannot be mixed.
    effect: { type: "screen", name: "slam" },
  });
  linqMessage("hello", {
    // @ts-expect-error -- effect families are closed.
    effect: { type: "fullscreen", name: "confetti" },
  });
}

void assertLinqMessageErgonomics;

function assertConversationErgonomics(
  adapter: LinqAdapter,
  thread: Thread,
  content: AdapterPostableMessage,
): void {
  const byId = adapter.conversation("linq:11111111-1111-1111-1111-111111111111");
  const byThread = adapter.conversation(thread);

  expectTypeOf(byId).toEqualTypeOf<LinqConversation>();
  expectTypeOf(byThread.threadId).toBeString();
  expectTypeOf(
    byId.replyToPart("22222222-2222-2222-2222-222222222222", 0, content),
  ).resolves.toMatchTypeOf<SentMessage>();
  expectTypeOf(
    byId.addReaction("22222222-2222-2222-2222-222222222222", "heart", { partIndex: 0 }),
  ).resolves.toBeVoid();
  expectTypeOf(
    byId.removeReaction("22222222-2222-2222-2222-222222222222", "heart"),
  ).resolves.toBeVoid();
  expectTypeOf(byId.stopTyping()).resolves.toBeVoid();
  expectTypeOf(byId.shareContactCard()).resolves.toBeVoid();
  expectTypeOf(
    byId.sendVoiceMemo({ url: new URL("https://example.com/memo.m4a") }),
  ).resolves.toEqualTypeOf<LinqVoiceMemoResult>();
  expectTypeOf(
    byId.sendVoiceMemo({ attachmentId: "33333333-3333-3333-3333-333333333333" }),
  ).resolves.toEqualTypeOf<LinqVoiceMemoResult>();
  expectTypeOf(byId.group).toEqualTypeOf<LinqGroupConversation>();
  expectTypeOf(
    byId.group.update({ displayName: "Example", iconUrl: new URL("https://example.com/icon.png") }),
  ).resolves.toBeVoid();
  expectTypeOf(byId.group.addParticipant("+15550000001")).resolves.toBeVoid();
  expectTypeOf(byId.group.removeParticipant("+15550000001")).resolves.toBeVoid();
  expectTypeOf(byId.group.leave()).resolves.toBeVoid();
  // @ts-expect-error -- endpoint-shaped update fields are not part of the facade.
  byId.group.update({ display_name: "Example" });
  // @ts-expect-error -- participant service/capability selection remains provider-owned.
  byId.group.addParticipant({ handle: "+15550000001", service: "iMessage" });
  // @ts-expect-error -- participant methods accept one canonical handle, not recipient lists.
  byId.group.removeParticipant(["+15550000001"]);
  expectTypeOf(byId.location).toEqualTypeOf<LinqLocationConversation>();
  expectTypeOf(byId.location.request()).resolves.toBeVoid();
  expectTypeOf(byId.location.retrieve()).resolves.toEqualTypeOf<LinqLocationSnapshot>();
  // @ts-expect-error -- location requests take no adapter polling or consent options.
  byId.location.request({ duration: 3_600 });
  // @ts-expect-error -- retrieval is an on-demand snapshot, not a polling API.
  byId.location.retrieve({ pollInterval: 1_000 });

  // @ts-expect-error -- voice memo sources are mutually exclusive.
  byId.sendVoiceMemo({
    url: "https://example.com/memo.m4a",
    attachmentId: "33333333-3333-3333-3333-333333333333",
  });
  // @ts-expect-error -- raw bytes belong to the deferred media-lifecycle batch.
  byId.sendVoiceMemo({ data: new Uint8Array([1]) });
  // @ts-expect-error -- a voice memo source cannot be omitted.
  byId.sendVoiceMemo({});
  // @ts-expect-error -- FileUpload-like source objects are intentionally unsupported.
  byId.sendVoiceMemo({ file: { data: new Uint8Array([1]), name: "memo.m4a" } });
  // @ts-expect-error -- mark-read remains on the standard Chat SDK Thread.
  byId.markAsRead("22222222-2222-2222-2222-222222222222");
  // @ts-expect-error -- common conversation operations are not flat adapter aliases.
  adapter.stopTyping("linq:11111111-1111-1111-1111-111111111111");
  // @ts-expect-error -- group operations remain nested on the conversation facade.
  adapter.addParticipant("linq:11111111-1111-1111-1111-111111111111", "+15550000001");

  // @ts-expect-error -- endpoint-shaped aliases are intentionally excluded.
  adapter.postReply("linq:11111111-1111-1111-1111-111111111111", content);
  byId.addReaction("22222222-2222-2222-2222-222222222222", "heart", {
    // @ts-expect-error -- the public option uses application-facing camelCase.
    part_index: 0,
  });
  linqMessage("hello", {
    // @ts-expect-error -- reply targeting belongs only on the conversation facade.
    replyTo: { messageId: "22222222-2222-2222-2222-222222222222", partIndex: 0 },
  });
}

void assertConversationErgonomics;

type Assert<T extends true> = T;
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;

type _KnownEventMapIsComplete = Assert<Equal<keyof LinqEventMap, LinqKnownEventType>>;
type _ConversationSurfaceIsExact = Assert<
  Equal<
    keyof LinqConversation,
    | "threadId"
    | "replyToPart"
    | "addReaction"
    | "removeReaction"
    | "stopTyping"
    | "shareContactCard"
    | "sendVoiceMemo"
    | "group"
    | "location"
  >
>;
type _GroupSurfaceIsExact = Assert<
  Equal<keyof LinqGroupConversation, "update" | "addParticipant" | "removeParticipant" | "leave">
>;
type _LocationSurfaceIsExact = Assert<
  Equal<keyof LinqLocationConversation, "request" | "retrieve">
>;

const voiceMemoSourceContract = {} as LinqVoiceMemoSource;
const voiceMemoResultContract = {} as LinqVoiceMemoResult;
const groupUpdateContract = {} as LinqGroupUpdateOptions;
const locationContract = {} as LinqSharedLocation;
const locationStartedContract = {} as LinqLocationSharingStartedEventData;
const locationStoppedContract = {} as LinqLocationSharingStoppedEventData;
expectTypeOf(voiceMemoResultContract.messageId).toBeString();
expectTypeOf(voiceMemoResultContract.threadId).toBeString();
expectTypeOf(voiceMemoResultContract.attachmentId).toBeString();
expectTypeOf(groupUpdateContract.displayName).toEqualTypeOf<string | undefined>();
expectTypeOf(groupUpdateContract.iconUrl).toEqualTypeOf<string | URL | undefined>();
expectTypeOf(locationContract.handle).toBeString();
expectTypeOf(locationContract.longitude).toBeNumber();
expectTypeOf(locationContract.latitude).toBeNumber();
expectTypeOf(locationContract.altitude).toEqualTypeOf<number | undefined>();
expectTypeOf(locationContract.updatedAt).toEqualTypeOf<string | undefined>();
expectTypeOf(locationStartedContract.sharedBy).toBeString();
expectTypeOf(locationStartedContract.sharedWith).toBeString();
expectTypeOf(locationStartedContract.beganAt).toEqualTypeOf<string | null>();
expectTypeOf(locationStartedContract.endsAt).toEqualTypeOf<string | null>();
expectTypeOf(locationStoppedContract.sharedBy).toBeString();
expectTypeOf(locationStoppedContract.sharedWith).toBeString();
expectTypeOf(
  {} as LinqEventMap["location.sharing.started"]["data"],
).toEqualTypeOf<LinqLocationSharingStartedEventData>();
expectTypeOf(
  {} as LinqEventMap["location.sharing.stopped"]["data"],
).toEqualTypeOf<LinqLocationSharingStoppedEventData>();
void voiceMemoSourceContract;

const futureEventContract = {
  type: "future.provider_event",
  data: { nested: ["lossless", 1, true, null] },
  envelope: {
    provider: "linq",
    apiVersion: "v3",
    webhookVersion: "2099-01-01",
    versionStatus: "future",
    eventType: "future.provider_event",
    eventId: "future-event-id",
    createdAt: "2099-01-01T00:00:00.000Z",
    traceId: "future-trace-id",
    partnerId: "future-partner-id",
  },
  transport: {
    scheme: "standard",
    webhookId: "future-webhook-id",
    timestamp: "4070908800",
  },
  rawEvent: {
    api_version: "v3",
    webhook_version: "2099-01-01",
    event_type: "future.provider_event",
    event_id: "future-event-id",
    created_at: "2099-01-01T00:00:00.000Z",
    trace_id: "future-trace-id",
    partner_id: "future-partner-id",
    data: { nested: ["lossless", 1, true, null] },
  },
} as const satisfies LinqFutureEvent;

expectTypeOf(futureEventContract).toMatchTypeOf<LinqAnyEvent>();

describe("public adapter foundation", () => {
  it("exports the concrete adapter and preserves the factory return type", () => {
    const adapter = createLinqAdapter(config);

    expect(adapter).toBeInstanceOf(LinqAdapter);
    expectTypeOf(adapter).toEqualTypeOf<LinqAdapter>();
    expectTypeOf(createLinqAdapter).returns.toEqualTypeOf<LinqAdapter>();
  });

  it("exposes the configured LinqAPIV3 client", () => {
    const adapter = createLinqAdapter(config);
    const client = adapter.client;

    expect(client).toBeInstanceOf(LinqAPIV3);
    expect(adapter.client).toBe(client);
    expectTypeOf(client).toEqualTypeOf<LinqAPIV3>();
    expect(client.apiKey).toBe(API_KEY);
    expect(client.baseURL).toBe(BASE_URL);
    expect(client.webhookSecret).toBeNull();
    expectTypeOf(client.blockedHandles.list).toBeFunction();
    expectTypeOf(client.chats.background.set).toBeFunction();
    expectTypeOf(client.chats.polls.create).toBeFunction();
    expectTypeOf(client.messages.poll.retrieve).toBeFunction();
    expectTypeOf(client.phoneNumbers.startReputationAudit).toBeFunction();
    expectTypeOf(client.experiences.list).toBeFunction();
  });

  it("implements Chat SDK standard reply/read without enabling local history", () => {
    const adapter = createLinqAdapter(config);

    expectTypeOf(adapter.reply).toBeFunction();
    expectTypeOf(adapter.markAsRead).toBeFunction();
    expect(adapter).not.toHaveProperty("persistMessageHistory");
  });

  it("exports the two-phase verified webhook contract", () => {
    const adapter = createLinqAdapter(config);

    expect(LINQ_WEBHOOK_VERSION).toBe("2026-02-03");
    expectTypeOf(
      adapter.verifyWebhook,
    ).returns.resolves.toEqualTypeOf<LinqWebhookVerificationResult>();
    expectTypeOf(adapter.dispatchVerifiedWebhook).parameter(0).toEqualTypeOf<LinqVerifiedWebhook>();
  });

  it("registers typed Linq event handlers and validates runtime forms", () => {
    const adapter = createLinqAdapter(config);
    const unsubscribe = adapter.onLinqEvent("message.sent", vi.fn());

    expect(unsubscribe).toBeTypeOf("function");
    expect(() => adapter.onLinqEvent([] as never, vi.fn())).toThrow(
      "onLinqEvent requires at least one event type",
    );
    expect(() => adapter.onLinqEvent("future.provider_event" as never, vi.fn())).toThrow(
      "Unsupported Linq event type",
    );
    expect(() => adapter.onLinqEvent("message.sent" as never)).toThrow(
      "onLinqEvent requires a handler",
    );
  });

  it("uses the exposed client instance for internal adapter operations", async () => {
    const adapter = createLinqAdapter(config);
    const client = adapter.client;
    const send = vi.spyOn(client.chats.messages, "send").mockResolvedValue({
      chat_id: "chat-123",
      message: {
        id: "message-123",
        created_at: "2026-08-02T12:00:00.000Z",
        delivery_status: "queued",
        is_read: false,
        parts: [{ type: "text", value: "hello", reactions: null }],
        sent_at: null,
      },
    });

    await adapter.postMessage("linq:chat-123", "hello");

    expect(send).toHaveBeenCalledWith("chat-123", {
      message: {
        idempotency_key: expect.any(String),
        parts: [{ type: "text", value: "hello" }],
      },
    });
  });
});
