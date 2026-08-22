import { randomUUID } from "node:crypto";
import type { LinqAPIV3 } from "@linqapp/sdk";
import type { AdapterPostableMessage, SentMessage, Thread } from "chat";

import type {
  LinqConversation,
  LinqGroupConversation,
  LinqGroupUpdateOptions,
  LinqLocationConversation,
  LinqLocationSnapshot,
  LinqSharedLocation,
  LinqVoiceMemoResult,
  LinqVoiceMemoSource,
} from "./adapter.js";
import {
  invalidLinqProviderResponse,
  linqValidationError as validationError,
  runLinqOperation,
} from "./errors.js";
import { isLinqUuid, isRecord } from "./guards.js";
import { withLinqReplyPartIndex } from "./message.js";
import {
  normalizePollAddOptions,
  normalizePollCreateInput,
  normalizePollMessageId,
  normalizePollSnapshot,
  normalizePollVoteInput,
  type LinqPollConversation,
  type LinqPollCreateOptions,
  type LinqPollSnapshot,
  type LinqPollVoteInput,
} from "./polls.js";
import {
  requireMatchingProviderId,
  requireProviderId,
  requireProviderRecord,
} from "./provider-boundary.js";
import { parseLinqTimestamp } from "./timestamps.js";
import {
  normalizeLinqHandle,
  normalizePublicHttpsUrl,
  validateLinqMessageId,
  validateLinqPartIndex,
  validateLinqPostableContent,
} from "./validation.js";

type PartReactionOptions = { readonly partIndex?: number };
type ReactionOperation = "add" | "remove";

interface LinqConversationFactoryOptions {
  readonly chatId: string;
  readonly encodeThreadId: (chatId: string, isGroup: boolean) => string;
  readonly getClient: () => Promise<LinqAPIV3>;
  readonly isGroup: boolean | undefined;
  readonly reactToPart: (
    threadId: string,
    messageId: string,
    reaction: string,
    operation: ReactionOperation,
    options?: PartReactionOptions,
  ) => Promise<void>;
  readonly thread: Thread;
  readonly threadId: string;
}

export function createLinqConversation({
  chatId,
  encodeThreadId,
  getClient,
  isGroup,
  reactToPart,
  thread,
  threadId,
}: LinqConversationFactoryOptions): LinqConversation {
  const group: LinqGroupConversation = Object.freeze({
    update: async (options: LinqGroupUpdateOptions): Promise<void> => {
      const request = normalizeGroupUpdate(options);
      validateKnownGroup(isGroup);
      const client = await getClient();

      return runLinqOperation(
        { action: "update group chat", resourceId: chatId, resourceType: "chat" },
        async () => {
          await client.chats.update(chatId, request);
        },
      );
    },
    addParticipant: async (handle: string): Promise<void> => {
      const normalizedHandle = normalizeParticipantHandle(handle);
      validateKnownGroup(isGroup);
      const client = await getClient();

      return runLinqOperation(
        { action: "add group chat participant", resourceId: chatId, resourceType: "chat" },
        async () => {
          await client.chats.participants.add(chatId, { handle: normalizedHandle });
        },
      );
    },
    removeParticipant: async (handle: string): Promise<void> => {
      const normalizedHandle = normalizeParticipantHandle(handle);
      validateKnownGroup(isGroup);
      const client = await getClient();

      return runLinqOperation(
        { action: "remove group chat participant", resourceId: chatId, resourceType: "chat" },
        async () => {
          await client.chats.participants.remove(chatId, { handle: normalizedHandle });
        },
      );
    },
    leave: async (): Promise<void> => {
      validateKnownGroup(isGroup);
      const client = await getClient();

      return runLinqOperation(
        { action: "leave group chat", resourceId: chatId, resourceType: "chat" },
        async () => {
          await client.chats.leaveChat(chatId);
        },
      );
    },
  });

  const location: LinqLocationConversation = Object.freeze({
    request: async (): Promise<void> => {
      if (isGroup === true) {
        throw validationError("Linq location requests require a direct chat.");
      }
      const client = await getClient();

      return runLinqOperation(
        { action: "request chat location", resourceId: chatId, resourceType: "chat" },
        async () => {
          const response = await client.chats.location.request(chatId);
          const responseRecord = requireProviderRecord(
            response,
            "request chat location",
            "response",
          );
          if (responseRecord.success !== true) {
            throw invalidLinqProviderResponse("request chat location", "success must be true");
          }
        },
      );
    },
    retrieve: async (): Promise<LinqLocationSnapshot> => {
      const client = await getClient();

      return runLinqOperation(
        { action: "retrieve chat location", resourceId: chatId, resourceType: "chat" },
        async () =>
          normalizeLocationSnapshot(threadId, await client.chats.location.retrieve(chatId)),
      );
    },
  });

  const polls: LinqPollConversation = Object.freeze({
    create: async (input: LinqPollCreateOptions): Promise<LinqPollSnapshot> => {
      const normalized = normalizePollCreateInput(input);
      const idempotencyKey = normalized.idempotencyKey ?? randomUUID();
      const client = await getClient();

      return runLinqOperation(
        { action: "create chat poll", resourceId: chatId, resourceType: "chat" },
        async () => {
          const response = await client.chats.polls.create(chatId, {
            poll: {
              options: normalized.options.map((option) => ({ text: option.text })),
              idempotency_key: idempotencyKey,
            },
          });
          return normalizePollSnapshot(threadId, chatId, response);
        },
      );
    },
    addOptions: async (
      messageId: string,
      options: readonly string[],
    ): Promise<LinqPollSnapshot> => {
      const normalizedMessageId = normalizePollMessageId(messageId);
      const normalized = normalizePollAddOptions(options);
      const client = await getClient();

      return runLinqOperation(
        {
          action: "add chat poll options",
          resourceId: normalizedMessageId,
          resourceType: "message",
        },
        async () => {
          const response = await client.messages.poll.addOptions(
            normalizedMessageId,
            { options: normalized.map((option) => ({ text: option.text })) },
            { maxRetries: 0 },
          );
          return normalizePollSnapshot(threadId, chatId, response, normalizedMessageId);
        },
      );
    },
    vote: async (messageId: string, input: LinqPollVoteInput): Promise<LinqPollSnapshot> => {
      const normalizedMessageId = normalizePollMessageId(messageId);
      const normalized = normalizePollVoteInput(input);
      const client = await getClient();

      return runLinqOperation(
        {
          action: "vote on chat poll",
          resourceId: normalizedMessageId,
          resourceType: "message",
        },
        async () => {
          const response = await client.messages.poll.vote(
            normalizedMessageId,
            { option_id: normalized.optionId, operation: normalized.operation },
            { maxRetries: 0 },
          );
          return normalizePollSnapshot(threadId, chatId, response, normalizedMessageId);
        },
      );
    },
    retrieve: async (messageId: string): Promise<LinqPollSnapshot> => {
      const normalizedMessageId = normalizePollMessageId(messageId);
      const client = await getClient();

      return runLinqOperation(
        {
          action: "retrieve chat poll",
          resourceId: normalizedMessageId,
          resourceType: "message",
        },
        async () =>
          normalizePollSnapshot(
            threadId,
            chatId,
            await client.messages.poll.retrieve(normalizedMessageId),
            normalizedMessageId,
          ),
      );
    },
  });

  return Object.freeze({
    threadId,
    group,
    location,
    polls,
    replyToPart: async (
      messageId: string,
      partIndex: number,
      content: AdapterPostableMessage,
    ): Promise<SentMessage> => {
      validateLinqMessageId(messageId);
      validateLinqPartIndex(partIndex);
      validateLinqPostableContent(content);
      return thread.reply(messageId, withLinqReplyPartIndex(content, partIndex));
    },
    addReaction: async (
      messageId: string,
      reaction: string,
      options?: PartReactionOptions,
    ): Promise<void> => reactToPart(threadId, messageId, reaction, "add", options),
    removeReaction: async (
      messageId: string,
      reaction: string,
      options?: PartReactionOptions,
    ): Promise<void> => reactToPart(threadId, messageId, reaction, "remove", options),
    stopTyping: async (): Promise<void> => {
      const client = await getClient();
      return runLinqOperation(
        { action: "stop chat typing", resourceId: chatId, resourceType: "chat" },
        async () => {
          await client.chats.typing.stop(chatId);
        },
      );
    },
    shareContactCard: async (): Promise<void> => {
      const client = await getClient();
      return runLinqOperation(
        { action: "share chat contact card", resourceId: chatId, resourceType: "chat" },
        async () => {
          await client.chats.shareContactCard(chatId);
        },
      );
    },
    sendVoiceMemo: async (source: LinqVoiceMemoSource): Promise<LinqVoiceMemoResult> => {
      const request = normalizeVoiceMemoSource(source);
      const client = await getClient();

      return runLinqOperation(
        { action: "send chat voice memo", resourceId: chatId, resourceType: "chat" },
        async () => {
          const response = await client.chats.sendVoicememo(chatId, request);
          const responseRecord = requireProviderRecord(
            response,
            "send chat voice memo",
            "response",
          );
          const voiceMemo = requireProviderRecord(
            responseRecord.voice_memo,
            "send chat voice memo",
            "voice_memo",
          );
          const responseChat = requireProviderRecord(
            voiceMemo.chat,
            "send chat voice memo",
            "voice_memo.chat",
          );
          const responseAttachment = requireProviderRecord(
            voiceMemo.voice_memo,
            "send chat voice memo",
            "voice_memo.voice_memo",
          );
          const responseChatId = requireMatchingProviderId(
            responseChat.id,
            chatId,
            "send chat voice memo",
            "voice_memo.chat.id",
          );
          const messageId = requireProviderId(
            voiceMemo.id,
            "send chat voice memo",
            "voice_memo.id",
          );
          const attachmentId = requireProviderId(
            responseAttachment.id,
            "send chat voice memo",
            "voice_memo.voice_memo.id",
          );
          if (typeof responseChat.is_group !== "boolean") {
            throw invalidLinqProviderResponse(
              "send chat voice memo",
              "voice_memo.chat.is_group must be a boolean",
            );
          }

          return Object.freeze({
            messageId,
            threadId: encodeThreadId(responseChatId, responseChat.is_group),
            attachmentId,
          });
        },
      );
    },
  });
}

type LinqVoiceMemoRequest = { voice_memo_url: string } | { attachment_id: string };

function normalizeVoiceMemoSource(source: unknown): LinqVoiceMemoRequest {
  if (!isRecord(source)) {
    throw validationError("Linq voice memos require exactly one URL or attachment ID source.");
  }

  const hasUrl = Object.hasOwn(source, "url");
  const hasAttachmentId = Object.hasOwn(source, "attachmentId");
  if (hasUrl === hasAttachmentId) {
    throw validationError("Linq voice memos require exactly one URL or attachment ID source.");
  }

  if (hasUrl) {
    return {
      voice_memo_url: normalizePublicHttpsUrl(
        source.url,
        "Linq voice memo URLs must be valid public HTTPS URLs.",
      ),
    };
  }

  if (!isLinqUuid(source.attachmentId) || source.attachmentId.trim() !== source.attachmentId) {
    throw validationError("Linq voice memo attachment IDs must be UUIDs.");
  }

  return { attachment_id: source.attachmentId };
}

type LinqGroupUpdateRequest = { display_name?: string; group_chat_icon?: string };

function normalizeGroupUpdate(options: unknown): LinqGroupUpdateRequest {
  if (!isRecord(options)) {
    throw validationError("Linq group updates require an options object.");
  }

  const supportedKeys = new Set(["displayName", "iconUrl"]);
  if (Object.keys(options).some((key) => !supportedKeys.has(key))) {
    throw validationError("Linq group updates support only displayName and iconUrl.");
  }

  const request: LinqGroupUpdateRequest = {};
  if (options.displayName !== undefined) {
    if (typeof options.displayName !== "string") {
      throw validationError("Linq group display names must be strings.");
    }
    request.display_name = options.displayName;
  }
  if (options.iconUrl !== undefined) {
    request.group_chat_icon = normalizePublicHttpsUrl(
      options.iconUrl,
      "Linq group icons must be valid public HTTPS URLs.",
    );
  }
  if (request.display_name === undefined && request.group_chat_icon === undefined) {
    throw validationError("Linq group updates require a displayName or iconUrl.");
  }

  return request;
}

function normalizeParticipantHandle(handle: unknown): string {
  return normalizeLinqHandle(
    handle,
    "Linq participant handles must be E.164 phone numbers or email addresses.",
  );
}

function validateKnownGroup(isGroup: boolean | undefined): void {
  if (isGroup === false) {
    throw validationError("Linq group operations require a group chat.");
  }
}

function normalizeLocationSnapshot(threadId: string, response: unknown): LinqLocationSnapshot {
  const responseRecord = requireProviderRecord(response, "retrieve chat location", "response");
  const data = requireProviderRecord(responseRecord.data, "retrieve chat location", "data");
  if (
    responseRecord.success !== true ||
    data.type !== "FeatureCollection" ||
    !Array.isArray(data.features)
  ) {
    throw invalidLinqProviderResponse(
      "retrieve chat location",
      "response must contain a successful GeoJSON FeatureCollection",
    );
  }

  const locations = data.features.flatMap((feature): LinqSharedLocation[] => {
    if (
      !isRecord(feature) ||
      feature.type !== "Feature" ||
      !isRecord(feature.geometry) ||
      feature.geometry.type !== "Point" ||
      !Array.isArray(feature.geometry.coordinates) ||
      (feature.geometry.coordinates.length !== 2 && feature.geometry.coordinates.length !== 3) ||
      !isRecord(feature.properties)
    ) {
      return [];
    }

    const [longitude, latitude, rawAltitude] = feature.geometry.coordinates;
    const properties = feature.properties;
    if (
      typeof longitude !== "number" ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      typeof latitude !== "number" ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      typeof properties.handle !== "string" ||
      properties.handle.length === 0 ||
      (properties.updated_at !== undefined && parseLinqTimestamp(properties.updated_at) === null)
    ) {
      return [];
    }

    const location: {
      handle: string;
      longitude: number;
      latitude: number;
      altitude?: number;
      address?: string;
      locality?: string;
      updatedAt?: string;
    } = { handle: properties.handle, longitude, latitude };

    if (typeof rawAltitude === "number" && Number.isFinite(rawAltitude)) {
      location.altitude = rawAltitude;
    }
    if (typeof properties.address === "string") location.address = properties.address;
    if (typeof properties.locality === "string") location.locality = properties.locality;
    if (typeof properties.updated_at === "string") location.updatedAt = properties.updated_at;

    return [Object.freeze(location)];
  });

  return Object.freeze({ threadId, locations: Object.freeze(locations) });
}
