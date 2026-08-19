import type { LinqAPIV3 } from "@linqapp/sdk";

import { isRecord } from "./guards.js";

export const LINQ_WEBHOOK_VERSION = "2026-02-03" as const;

const VERIFIED_WEBHOOK = Symbol("Linq verified webhook");

export type LinqWebhookRawValue =
  | boolean
  | number
  | string
  | null
  | readonly LinqWebhookRawValue[]
  | { readonly [key: string]: LinqWebhookRawValue };

export interface LinqWebhookRawEvent {
  readonly [key: string]: LinqWebhookRawValue;
}

/** Stable provider envelope owned by the adapter, independent of generated SDK wrappers. */
export interface LinqWebhookEvent<TData = unknown> {
  readonly api_version: "v3";
  readonly webhook_version: string;
  readonly event_type: string;
  readonly event_id: string;
  readonly created_at: string;
  readonly trace_id: string;
  readonly partner_id: string;
  readonly data: TData;
}

export type LinqMessageReceivedWebhookEvent = LinqWebhookEvent<LinqAPIV3.MessageEventV2> & {
  readonly event_type: "message.received";
};

export interface LinqReactionWebhookData {
  readonly is_from_me: boolean;
  readonly reaction_type: LinqAPIV3.ReactionType;
  readonly chat_id?: string;
  readonly message_id?: string;
  readonly part_index?: number;
  readonly custom_emoji?: string | null;
  readonly reacted_at?: string | null;
  readonly service?: LinqAPIV3.ServiceType | null;
  readonly from_handle?: LinqAPIV3.ChatHandle | null;
  /** Deprecated legacy sender handle retained for old webhook versions. */
  readonly from?: string;
}

export type LinqReactionWebhookEvent = LinqWebhookEvent<LinqReactionWebhookData> & {
  readonly event_type: "reaction.added" | "reaction.removed";
};

export type LinqWebhookVerificationScheme = "standard" | "legacy";

export interface LinqWebhookTransportObservation {
  readonly scheme: LinqWebhookVerificationScheme;
  readonly webhookId: string | null;
  readonly timestamp: string;
  readonly subscriptionId: string | null;
  readonly eventType: string | null;
}

export interface LinqWebhookEnvelopeObservation {
  readonly provider: "linq";
  readonly apiVersion: "v3";
  readonly webhookVersion: string;
  readonly versionStatus: "current" | "older" | "future" | "unknown";
  readonly eventType: string;
  readonly eventId: string;
  readonly createdAt: string;
  readonly traceId: string;
  readonly partnerId: string;
}

export type LinqEndpointKind = "phone" | "email" | "unknown";

export interface LinqEndpointObservation {
  readonly kind: LinqEndpointKind;
  readonly value: string;
}

export interface LinqChatHandleObservation {
  readonly id: string;
  readonly handle: string;
  readonly joinedAt: string;
  readonly service: LinqAPIV3.ServiceType;
  readonly isMe: boolean | null;
  readonly leftAt: string | null;
  readonly status: "active" | "left" | "removed" | null;
  readonly endpoint: LinqEndpointObservation;
}

export type LinqConversationKind = "direct" | "group" | "unknown";

export type LinqMessageLifecycleEventType = "message.sent" | "message.delivered" | "message.read";

type LinqServicePreference = LinqAPIV3.ServiceType | "auto";

/** Curated current-version correlation facts for message lifecycle events. */
export interface LinqMessageLifecycleEventData {
  readonly providerMessageId: string;
  readonly chatId: string;
  readonly direction: "inbound" | "outbound";
  readonly service: LinqAPIV3.ServiceType;
  readonly preferredService: LinqServicePreference | null;
  readonly idempotencyKey: string | null;
  readonly sentAt: string;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
}

/** Provider failure facts; consumers must interpret retry safety from current Linq guidance. */
export interface LinqMessageFailedEventData {
  readonly providerMessageId: string | null;
  readonly chatId: string | null;
  readonly code: number;
  /** Opaque provider diagnostic. Preserve for support; do not branch on it. */
  readonly detailCode: number | null;
  readonly reason: string | null;
  readonly service: LinqAPIV3.ServiceType | null;
  readonly preferredService: LinqServicePreference | null;
  readonly failedAt: string;
}

export interface LinqMessageLifecycleObservation {
  readonly sentAt: string | null;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
  readonly reconciledAt: string | null;
}

export interface LinqReplyContextObservation {
  readonly messageId: string | null;
  readonly partIndex: number | null;
}

export interface LinqAttachmentObservation {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface LinqMessageObservation {
  readonly providerMessageId: string;
  readonly chatId: string;
  readonly conversationKind: LinqConversationKind;
  readonly direction: "inbound" | "outbound";
  readonly service: LinqAPIV3.ServiceType;
  readonly receivingEndpoint: LinqEndpointObservation | null;
  readonly remoteEndpoint: LinqEndpointObservation | null;
  readonly ownerHandle: LinqChatHandleObservation | null;
  readonly senderHandle: LinqChatHandleObservation;
  readonly timestamps: LinqMessageLifecycleObservation;
  readonly parts: readonly Readonly<Record<string, unknown>>[];
  readonly attachments: readonly LinqAttachmentObservation[];
  readonly replyContext: LinqReplyContextObservation | null;
}

export interface LinqReactionObservation {
  readonly chatId: string | null;
  readonly providerMessageId: string | null;
  readonly partIndex: number | null;
  readonly reactionType: string;
  readonly customEmoji: string | null;
  readonly reactedAt: string | null;
  readonly service: LinqAPIV3.ServiceType | null;
  readonly isFromMe: boolean;
  readonly senderHandle: LinqChatHandleObservation | null;
  readonly remoteEndpoint: LinqEndpointObservation | null;
}

interface LinqVerifiedWebhookBase {
  readonly envelope: LinqWebhookEnvelopeObservation;
  readonly transport: LinqWebhookTransportObservation;
  readonly rawEvent: LinqWebhookRawEvent;
  /** Exact authenticated request text. Persist this before dispatch for durable ingress. */
  readonly rawBody: string;
  /** Exact authenticated request bytes, encoded for immutable/persistence-safe transport. */
  readonly rawBodyBase64: string;
  readonly [VERIFIED_WEBHOOK]: LinqVerifiedWebhookInternal;
}

export interface LinqVerifiedMessageWebhook extends LinqVerifiedWebhookBase {
  readonly kind: "message.received";
  readonly message: LinqMessageObservation;
}

export interface LinqVerifiedMessageLifecycleWebhook extends LinqVerifiedWebhookBase {
  readonly kind: LinqMessageLifecycleEventType;
  readonly lifecycle: LinqMessageLifecycleEventData;
}

export interface LinqVerifiedMessageFailedWebhook extends LinqVerifiedWebhookBase {
  readonly kind: "message.failed";
  readonly failure: LinqMessageFailedEventData;
}

export interface LinqVerifiedReactionWebhook extends LinqVerifiedWebhookBase {
  readonly kind: "reaction.added" | "reaction.removed";
  readonly reaction: LinqReactionObservation;
}

export interface LinqVerifiedUnhandledWebhook extends LinqVerifiedWebhookBase {
  readonly kind: "unhandled";
}

export interface LinqVerifiedUnsupportedVersionWebhook extends LinqVerifiedWebhookBase {
  readonly kind: "unsupported_version";
}

export type LinqVerifiedWebhook =
  | LinqVerifiedMessageWebhook
  | LinqVerifiedMessageLifecycleWebhook
  | LinqVerifiedMessageFailedWebhook
  | LinqVerifiedReactionWebhook
  | LinqVerifiedUnhandledWebhook
  | LinqVerifiedUnsupportedVersionWebhook;

export type LinqWebhookVerificationErrorCode =
  | "missing_signature_headers"
  | "invalid_signature"
  | "stale_timestamp"
  | "missing_signing_secret"
  | "invalid_signing_secret"
  | "invalid_json"
  | "invalid_payload";

export interface LinqWebhookVerificationError {
  readonly code: LinqWebhookVerificationErrorCode;
  readonly message: string;
  readonly status: 400 | 401 | 503;
}

export interface LinqWebhookVerificationFailure {
  readonly ok: false;
  readonly error: LinqWebhookVerificationError;
}

export type LinqWebhookVerificationResult =
  | { readonly ok: true; readonly webhook: LinqVerifiedWebhook }
  | LinqWebhookVerificationFailure;

export interface LinqVerifiedWebhookDispatchResult {
  readonly handled: "message" | "reaction" | "ignored";
}

interface LinqVerifiedWebhookInternal {
  readonly authority: object;
  readonly event: LinqWebhookEvent;
}

export function normalizeAuthenticatedLinqWebhook(
  event: unknown,
  transport: LinqWebhookTransportObservation,
  rawBody: string,
  rawBodyBase64: string,
  authority: object,
): LinqWebhookVerificationResult {
  if (!isRecord(event)) {
    return invalidPayload();
  }

  const envelope = parseEnvelope(event);

  if (!envelope) {
    return invalidPayload();
  }

  const rawEvent = immutableJsonSnapshot(event);
  const base = {
    envelope,
    transport: Object.freeze(transport),
    rawEvent,
    rawBody,
    rawBodyBase64,
    [VERIFIED_WEBHOOK]: Object.freeze({
      authority,
      event: event as unknown as LinqWebhookEvent,
    }),
  };

  if (envelope.versionStatus !== "current") {
    return {
      ok: true,
      webhook: Object.freeze({ ...base, kind: "unsupported_version" }),
    };
  }

  if (envelope.eventType === "message.received") {
    const message = parseMessageObservation(rawEvent.data);

    if (!message) {
      return invalidPayload();
    }

    return {
      ok: true,
      webhook: Object.freeze({ ...base, kind: "message.received", message }),
    };
  }

  if (isMessageLifecycleEventType(envelope.eventType)) {
    const lifecycle = parseMessageLifecycleEventData(envelope.eventType, rawEvent.data);

    if (!lifecycle) {
      return invalidPayload();
    }

    return {
      ok: true,
      webhook: Object.freeze({ ...base, kind: envelope.eventType, lifecycle }),
    };
  }

  if (envelope.eventType === "message.failed") {
    const failureObservation = parseMessageFailedEventData(rawEvent.data);

    if (!failureObservation) {
      return invalidPayload();
    }

    return {
      ok: true,
      webhook: Object.freeze({ ...base, kind: "message.failed", failure: failureObservation }),
    };
  }

  if (envelope.eventType === "reaction.added" || envelope.eventType === "reaction.removed") {
    const reaction = parseReactionObservation(rawEvent.data);

    if (!reaction) {
      return invalidPayload();
    }

    return {
      ok: true,
      webhook: Object.freeze({ ...base, kind: envelope.eventType, reaction }),
    };
  }

  return {
    ok: true,
    webhook: Object.freeze({ ...base, kind: "unhandled" }),
  };
}

export function getVerifiedLinqWebhookEvent(
  webhook: LinqVerifiedWebhook,
  authority: object,
): LinqWebhookEvent {
  const internal = isRecord(webhook) ? webhook[VERIFIED_WEBHOOK] : undefined;

  if (!isRecord(internal) || internal.authority !== authority || !("event" in internal)) {
    throw new TypeError("Expected a verified Linq webhook produced by this adapter");
  }

  return internal.event as LinqWebhookEvent;
}

export function failure(
  code: LinqWebhookVerificationErrorCode,
  status: 400 | 401 | 503,
  message: string,
): LinqWebhookVerificationFailure {
  return { ok: false, error: { code, status, message } };
}

export function responseForLinqWebhookFailure(
  failureResult: LinqWebhookVerificationFailure,
): Response {
  return new Response(failureResult.error.message, { status: failureResult.error.status });
}

function invalidPayload(): LinqWebhookVerificationFailure {
  return failure("invalid_payload", 400, "Invalid Linq webhook payload");
}

function parseEnvelope(event: Record<string, unknown>): LinqWebhookEnvelopeObservation | null {
  if (
    event.api_version !== "v3" ||
    !isNonEmptyString(event.webhook_version) ||
    !isNonEmptyString(event.event_type) ||
    !isNonEmptyString(event.event_id) ||
    !isNonEmptyString(event.created_at) ||
    !isNonEmptyString(event.trace_id) ||
    !isNonEmptyString(event.partner_id) ||
    !("data" in event)
  ) {
    return null;
  }

  return Object.freeze({
    provider: "linq",
    apiVersion: "v3",
    webhookVersion: event.webhook_version,
    versionStatus: classifyWebhookVersion(event.webhook_version),
    eventType: event.event_type,
    eventId: event.event_id,
    createdAt: event.created_at,
    traceId: event.trace_id,
    partnerId: event.partner_id,
  });
}

function parseMessageObservation(value: unknown): LinqMessageObservation | null {
  if (!isRecord(value) || !isRecord(value.chat)) {
    return null;
  }

  const chat = value.chat;
  const ownerHandle = valueOrNull(chat.owner_handle);
  const replyTo = valueOrNull(value.reply_to);

  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(chat.id) ||
    !isNullableBoolean(chat.is_group) ||
    (ownerHandle !== null && !isChatHandle(ownerHandle)) ||
    !isChatHandle(value.sender_handle) ||
    (value.direction !== "inbound" && value.direction !== "outbound") ||
    !isService(value.service) ||
    !isNullableTimestamp(value.sent_at) ||
    !isNullableTimestamp(value.delivered_at) ||
    !isNullableTimestamp(value.read_at) ||
    !isNullableTimestamp(value.reconciled_at) ||
    !isMessageParts(value.parts) ||
    (replyTo !== null && !isReplyContext(replyTo))
  ) {
    return null;
  }

  const parsedOwner = ownerHandle === null ? null : chatHandleObservation(ownerHandle);
  const parsedSender = chatHandleObservation(value.sender_handle);
  const attachments = value.parts.flatMap((part): LinqAttachmentObservation[] => {
    if (part.type !== "media") {
      return [];
    }

    return [
      Object.freeze({
        id: part.id as string,
        filename: part.filename as string,
        mimeType: part.mime_type as string,
        sizeBytes: part.size_bytes as number,
        url: part.url as string,
        width: optionalFiniteNumber(part.width ?? part.width_px),
        height: optionalFiniteNumber(part.height ?? part.height_px),
      }),
    ];
  });

  return Object.freeze({
    providerMessageId: value.id,
    chatId: chat.id,
    conversationKind:
      chat.is_group === true ? "group" : chat.is_group === false ? "direct" : "unknown",
    direction: value.direction,
    service: value.service,
    receivingEndpoint: parsedOwner?.endpoint ?? null,
    remoteEndpoint: value.direction === "inbound" ? parsedSender.endpoint : null,
    ownerHandle: parsedOwner,
    senderHandle: parsedSender,
    timestamps: Object.freeze({
      sentAt: nullableTimestamp(value.sent_at),
      deliveredAt: nullableTimestamp(value.delivered_at),
      readAt: nullableTimestamp(value.read_at),
      reconciledAt: nullableTimestamp(value.reconciled_at),
    }),
    parts: value.parts,
    attachments: Object.freeze(attachments),
    replyContext:
      replyTo === null
        ? null
        : Object.freeze({
            messageId: isNonEmptyString(replyTo.message_id) ? replyTo.message_id : null,
            partIndex: Number.isInteger(replyTo.part_index) ? (replyTo.part_index as number) : null,
          }),
  });
}

function isMessageLifecycleEventType(value: string): value is LinqMessageLifecycleEventType {
  return value === "message.sent" || value === "message.delivered" || value === "message.read";
}

function parseMessageLifecycleEventData(
  eventType: LinqMessageLifecycleEventType,
  value: unknown,
): LinqMessageLifecycleEventData | null {
  const message = parseMessageObservation(value);

  if (!message || !isRecord(value) || message.timestamps.sentAt === null) {
    return null;
  }

  if (
    (eventType === "message.sent" &&
      (message.timestamps.deliveredAt !== null || message.timestamps.readAt !== null)) ||
    (eventType === "message.delivered" &&
      (message.timestamps.deliveredAt === null || message.timestamps.readAt !== null)) ||
    (eventType === "message.read" &&
      (message.timestamps.deliveredAt === null || message.timestamps.readAt === null)) ||
    !isNullableString(value.idempotency_key) ||
    !isNullableServicePreference(value.preferred_service)
  ) {
    return null;
  }

  return Object.freeze({
    providerMessageId: message.providerMessageId,
    chatId: message.chatId,
    direction: message.direction,
    service: message.service,
    preferredService: isServicePreference(value.preferred_service) ? value.preferred_service : null,
    idempotencyKey: typeof value.idempotency_key === "string" ? value.idempotency_key : null,
    sentAt: message.timestamps.sentAt,
    deliveredAt: message.timestamps.deliveredAt,
    readAt: message.timestamps.readAt,
  });
}

function parseMessageFailedEventData(value: unknown): LinqMessageFailedEventData | null {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.code) ||
    !isNonEmptyString(value.failed_at) ||
    !isOptionalNonEmptyString(value.chat_id) ||
    !isOptionalNonEmptyString(value.message_id) ||
    !isOptionalString(value.reason) ||
    !isNullableInteger(value.detail_code) ||
    !isNullableService(value.service) ||
    !isNullableServicePreference(value.preferred_service)
  ) {
    return null;
  }

  return Object.freeze({
    providerMessageId: isNonEmptyString(value.message_id) ? value.message_id : null,
    chatId: isNonEmptyString(value.chat_id) ? value.chat_id : null,
    code: value.code as number,
    detailCode: Number.isInteger(value.detail_code) ? (value.detail_code as number) : null,
    reason: typeof value.reason === "string" ? value.reason : null,
    service: isService(value.service) ? value.service : null,
    preferredService: isServicePreference(value.preferred_service) ? value.preferred_service : null,
    failedAt: value.failed_at,
  });
}

function isMessageParts(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.every((part) => {
    if (!isRecord(part) || !isNonEmptyString(part.type)) {
      return false;
    }

    if (part.type === "text" || part.type === "link") {
      return typeof part.value === "string";
    }

    if (part.type === "media") {
      return (
        isNonEmptyString(part.id) &&
        isNonEmptyString(part.filename) &&
        isNonEmptyString(part.mime_type) &&
        typeof part.size_bytes === "number" &&
        Number.isFinite(part.size_bytes) &&
        part.size_bytes >= 0 &&
        isNonEmptyString(part.url)
      );
    }

    if (part.type === "imessage_app") {
      return isNonEmptyString(part.url) && isRecord(part.app) && isRecord(part.layout);
    }

    return true;
  });
}

function isChatHandle(value: unknown): value is Record<string, unknown> & {
  id: string;
  handle: string;
  joined_at: string;
  service: LinqAPIV3.ServiceType;
} {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.handle) &&
    isNonEmptyString(value.joined_at) &&
    isService(value.service) &&
    isNullableBoolean(value.is_me) &&
    isNullableTimestamp(value.left_at) &&
    (value.status === undefined ||
      value.status === null ||
      value.status === "active" ||
      value.status === "left" ||
      value.status === "removed")
  );
}

function chatHandleObservation(
  handle: Record<string, unknown> & {
    id: string;
    handle: string;
    joined_at: string;
    service: LinqAPIV3.ServiceType;
  },
): LinqChatHandleObservation {
  return Object.freeze({
    id: handle.id,
    handle: handle.handle,
    joinedAt: handle.joined_at,
    service: handle.service,
    isMe: typeof handle.is_me === "boolean" ? handle.is_me : null,
    leftAt: typeof handle.left_at === "string" ? handle.left_at : null,
    status:
      handle.status === "active" || handle.status === "left" || handle.status === "removed"
        ? handle.status
        : null,
    endpoint: classifyLinqEndpoint(handle.handle),
  });
}

function classifyLinqEndpoint(value: string): LinqEndpointObservation {
  const kind: LinqEndpointKind = /^\+[1-9]\d{1,14}$/.test(value)
    ? "phone"
    : isConservativeEmail(value)
      ? "email"
      : "unknown";

  return Object.freeze({ kind, value });
}

function isConservativeEmail(value: string): boolean {
  if (/\s/.test(value)) {
    return false;
  }

  const separator = value.indexOf("@");
  return separator > 0 && separator === value.lastIndexOf("@") && separator < value.length - 1;
}

function isReplyContext(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (value.message_id === undefined || isNonEmptyString(value.message_id)) &&
    (value.part_index === undefined ||
      (Number.isInteger(value.part_index) && (value.part_index as number) >= 0))
  );
}

function parseReactionObservation(value: unknown): LinqReactionObservation | null {
  if (!isRecord(value)) {
    return null;
  }

  const senderHandle = valueOrNull(value.from_handle);

  if (
    typeof value.is_from_me !== "boolean" ||
    !isNonEmptyString(value.reaction_type) ||
    (value.chat_id !== undefined && !isNonEmptyString(value.chat_id)) ||
    (value.message_id !== undefined && !isNonEmptyString(value.message_id)) ||
    (value.part_index !== undefined &&
      (!Number.isInteger(value.part_index) || (value.part_index as number) < 0)) ||
    (value.custom_emoji !== undefined &&
      value.custom_emoji !== null &&
      typeof value.custom_emoji !== "string") ||
    (value.reacted_at !== undefined &&
      value.reacted_at !== null &&
      typeof value.reacted_at !== "string") ||
    (value.service !== undefined && value.service !== null && !isService(value.service)) ||
    (senderHandle !== null && !isChatHandle(senderHandle))
  ) {
    return null;
  }

  const parsedSender = senderHandle === null ? null : chatHandleObservation(senderHandle);
  const deprecatedFrom = isNonEmptyString(value.from) ? classifyLinqEndpoint(value.from) : null;

  return Object.freeze({
    chatId: isNonEmptyString(value.chat_id) ? value.chat_id : null,
    providerMessageId: isNonEmptyString(value.message_id) ? value.message_id : null,
    partIndex: Number.isInteger(value.part_index) ? (value.part_index as number) : null,
    reactionType: value.reaction_type,
    customEmoji: typeof value.custom_emoji === "string" ? value.custom_emoji : null,
    reactedAt: typeof value.reacted_at === "string" ? value.reacted_at : null,
    service: isService(value.service) ? value.service : null,
    isFromMe: value.is_from_me,
    senderHandle: parsedSender,
    remoteEndpoint: value.is_from_me ? null : (parsedSender?.endpoint ?? deprecatedFrom),
  });
}

function isService(value: unknown): value is LinqAPIV3.ServiceType {
  return value === "iMessage" || value === "SMS" || value === "RCS";
}

function isNullableService(value: unknown): boolean {
  return value === undefined || value === null || isService(value);
}

function isNullableServicePreference(value: unknown): boolean {
  return value === undefined || value === null || isServicePreference(value);
}

function isServicePreference(value: unknown): value is LinqServicePreference {
  return value === "auto" || isService(value);
}

function isNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isNullableInteger(value: unknown): boolean {
  return value === undefined || value === null || Number.isInteger(value);
}

function isNullableBoolean(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "boolean";
}

function isNullableTimestamp(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function nullableTimestamp(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function valueOrNull(value: unknown): unknown | null {
  return value === undefined || value === null ? null : value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function classifyWebhookVersion(version: string): LinqWebhookEnvelopeObservation["versionStatus"] {
  if (version === LINQ_WEBHOOK_VERSION) {
    return "current";
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(version)) {
    return version < LINQ_WEBHOOK_VERSION ? "older" : "future";
  }

  return "unknown";
}

function immutableJsonSnapshot(event: Record<string, unknown>): LinqWebhookRawEvent {
  return deepFreeze(structuredClone(event)) as LinqWebhookRawEvent;
}

function deepFreeze<T>(value: T): T {
  if (!isRecord(value) && !Array.isArray(value)) {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return Object.freeze(value);
}
