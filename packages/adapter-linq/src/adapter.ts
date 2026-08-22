import { randomUUID } from "node:crypto";
import { ValidationError } from "@chat-adapter/shared";
import { LinqAPIV3 } from "@linqapp/sdk";
import { ConsoleLogger, Message, NotImplementedError, stringifyMarkdown } from "chat";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  RawMessage,
  StateAdapter,
  StreamChunk,
  SentMessage,
  Thread,
  ThreadInfo,
  WebhookOptions,
} from "chat";

import { cardHasInteractiveActions, collectCardImageUrls, extractCardElement } from "./cards.js";
import { translateLinqError } from "./errors.js";
import {
  createLinqEvent,
  isLinqKnownEventType,
  LinqEventRegistry,
  type LinqAnyEvent,
  type LinqEventHandler,
  type LinqEventMap,
  type LinqKnownEventType,
} from "./events.js";
import { isRecord } from "./guards.js";
import { createLinqAttachmentFetcher } from "./inbound-media.js";
import {
  isMessageReceivedWebhookEvent,
  isReactionWebhookEvent,
  parseLinqMessage,
  type LinqRawMessage,
} from "./message-parser.js";
import { planLinqOutboundMessage, prepareLinqOutboundParts } from "./outbound-media.js";
import { compileLinqMessageText, compileLinqSendOptions } from "./message-compiler.js";
import { getLinqReplyPartIndex, withLinqReplyPartIndex } from "./message.js";
import { fromLinqReaction, toLinqReaction } from "./reactions.js";
import {
  authenticateLinqWebhookRequest,
  authenticateTrustedLinqWebhookRequest,
  type LinqWebhookAuthenticationResult,
} from "./verification.js";
import {
  failure,
  getVerifiedLinqWebhookEvent,
  normalizeAuthenticatedLinqWebhook,
  responseForLinqWebhookFailure,
  type LinqVerifiedWebhook,
  type LinqVerifiedWebhookDispatchResult,
  type LinqMessageReceivedWebhookEvent,
  type LinqReactionWebhookEvent,
  type LinqWebhookEvent,
  type LinqWebhookVerificationResult,
} from "./webhook.js";

type LinqThreadId = {
  chatId: string;
  isGroup?: boolean;
  /** Target handle for an upstream-compatible thread whose chat is created by its first post. */
  pendingHandle?: string;
};

const LINQ_EVENT_DEDUPE_TTL_MS = 60 * 60 * 1000;

/** Credentials for provider operations and direct Standard Webhook verification. */
export interface LinqCredentials {
  apiKey: string;
  signingSecret?: string;
}

/** Resolves current credentials for each adapter-owned provider operation. */
export type LinqCredentialProvider = () => LinqCredentials | Promise<LinqCredentials>;

/** Authenticates a request delivered through an explicitly trusted forwarder. */
export type LinqWebhookVerifier = (
  request: Request,
  rawBody: Uint8Array,
) => unknown | Promise<unknown>;

export interface LinqAdapterConfig {
  /** Static API key. Omit when `credentials` supplies rotating credentials. */
  apiKey?: string;
  baseURL?: string;
  /** Lazy credential source. A fresh client is built for each provider operation. */
  credentials?: LinqCredentialProvider;
  /** Static Standard Webhooks secret. May instead be supplied by `credentials`. */
  signingSecret?: string;
  /** Explicit verifier for authenticated forwarded webhooks; never falls back to direct signing. */
  webhookVerifier?: LinqWebhookVerifier;
}

/** Delivery outcome Linq reported for an outbound message. */
export type LinqDeliveryStatus = "sent" | "delivered" | "read" | "failed";

/** A compatibility view over one authenticated lifecycle event. */
export interface LinqDeliveryStatusEvent {
  readonly status: LinqDeliveryStatus;
  readonly threadId: string;
  readonly messageId: string;
  readonly error?: { readonly code?: number; readonly message?: string };
  readonly raw: unknown;
}

/** Receives delivery-status changes. Completion is observed only to isolate failures. */
export type LinqDeliveryStatusListener = (
  event: LinqDeliveryStatusEvent,
) => void | PromiseLike<void>;

type LinqPartReactionOptions = {
  readonly partIndex?: number;
};

export type LinqVoiceMemoSource =
  | { readonly url: string | URL; readonly attachmentId?: never }
  | { readonly attachmentId: string; readonly url?: never };

export interface LinqVoiceMemoResult {
  readonly messageId: string;
  readonly threadId: string;
  readonly attachmentId: string;
}

export interface LinqGroupUpdateOptions {
  readonly displayName?: string;
  readonly iconUrl?: string | URL;
}

export interface LinqGroupConversation {
  update(options: LinqGroupUpdateOptions): Promise<void>;
  addParticipant(handle: string): Promise<void>;
  removeParticipant(handle: string): Promise<void>;
  leave(): Promise<void>;
}

export interface LinqSharedLocation {
  readonly handle: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly altitude?: number;
  readonly address?: string;
  readonly locality?: string;
  readonly updatedAt?: string;
}

export interface LinqLocationSnapshot {
  readonly threadId: string;
  readonly locations: readonly LinqSharedLocation[];
}

export interface LinqLocationConversation {
  request(): Promise<void>;
  retrieve(): Promise<LinqLocationSnapshot>;
}

export interface LinqConversation {
  readonly threadId: string;
  replyToPart(
    messageId: string,
    partIndex: number,
    content: AdapterPostableMessage,
  ): Promise<SentMessage>;
  addReaction(
    messageId: string,
    reaction: string,
    options?: LinqPartReactionOptions,
  ): Promise<void>;
  removeReaction(
    messageId: string,
    reaction: string,
    options?: LinqPartReactionOptions,
  ): Promise<void>;
  stopTyping(): Promise<void>;
  shareContactCard(): Promise<void>;
  sendVoiceMemo(source: LinqVoiceMemoSource): Promise<LinqVoiceMemoResult>;
  readonly group: LinqGroupConversation;
  readonly location: LinqLocationConversation;
}

type ChatWithThreads = ChatInstance & { thread(threadId: string): Thread };

const MAX_CONSECUTIVE_FILTERED_HISTORY_PAGES = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class LinqAdapter implements Adapter<LinqThreadId, LinqRawMessage> {
  readonly name: string = "linq";
  readonly userName: string = "linq";
  private apiClient: LinqAPIV3 | null;
  private readonly baseURL: string | undefined;
  private readonly credentials: LinqCredentialProvider | undefined;
  private readonly signingSecret: string | undefined;
  private readonly webhookVerifier: LinqWebhookVerifier | undefined;
  private readonly webhookVerificationAuthority = {};
  private readonly linqEvents = new LinqEventRegistry();

  private chat: ChatWithThreads | null = null;
  private state: StateAdapter | null = null;
  private logger: Logger;
  // chatId -> isGroup, learned from webhooks, fetchThread, and legacy thread IDs.
  private readonly chatKinds = new Map<string, boolean>();
  private readonly deliveryStatusListeners = new Set<LinqDeliveryStatusListener>();

  constructor(config: LinqAdapterConfig) {
    if (!config.apiKey && !config.credentials) {
      throw new Error("Linq requires apiKey or a credentials provider.");
    }
    if (!config.webhookVerifier && !config.signingSecret?.trim() && !config.credentials) {
      throw new Error("Linq requires signingSecret, credentials, or a trusted webhookVerifier.");
    }

    this.apiClient = config.apiKey
      ? new LinqAPIV3({ apiKey: config.apiKey, baseURL: config.baseURL })
      : null;
    this.baseURL = config.baseURL;
    this.credentials = config.credentials;
    this.signingSecret = config.signingSecret;
    this.webhookVerifier = config.webhookVerifier;
    this.logger = new ConsoleLogger();
  }

  /**
   * Synchronous official client for static `apiKey` configurations.
   * Lazy configurations must use `getClient()` so credential rotation remains truthful.
   */
  get client(): LinqAPIV3 {
    if (!this.apiClient) {
      throw new Error("Linq lazy credentials require await adapter.getClient().");
    }
    return this.apiClient;
  }

  /** Resolve an official client using the current credentials. */
  async getClient(): Promise<LinqAPIV3> {
    return this.getApiClient();
  }

  private async getApiClient(): Promise<LinqAPIV3> {
    if (this.apiClient) {
      return this.apiClient;
    }

    const credentials = await this.credentials?.();
    if (!credentials?.apiKey) {
      throw new Error("Linq credentials did not provide an API key.");
    }

    return new LinqAPIV3({ apiKey: credentials.apiKey, baseURL: this.baseURL });
  }

  private async getSigningSecret(): Promise<string> {
    if (this.signingSecret) {
      return this.signingSecret;
    }

    const credentials = await this.credentials?.();
    if (!credentials?.signingSecret) {
      throw new Error("Linq credentials did not provide a webhook signing secret.");
    }

    return credentials.signingSecret;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat as ChatWithThreads;
    this.state = chat.getState();
    this.logger = chat.getLogger("linq");
  }

  conversation(threadOrId: Thread | string): LinqConversation {
    const thread = this.resolveConversationThread(threadOrId);
    const threadId = thread.id;
    const { chatId, isGroup } = this.decodeThreadId(threadId);
    const group: LinqGroupConversation = Object.freeze({
      update: async (options: LinqGroupUpdateOptions): Promise<void> => {
        const request = normalizeGroupUpdate(options);
        validateKnownGroup(isGroup);
        const client = await this.getApiClient();

        try {
          await client.chats.update(chatId, request);
        } catch (error) {
          throw translateLinqError(error, {
            action: "update group chat",
            resourceId: chatId,
            resourceType: "chat",
          });
        }
      },
      addParticipant: async (handle: string): Promise<void> => {
        validateParticipantHandle(handle);
        validateKnownGroup(isGroup);
        const client = await this.getApiClient();

        try {
          await client.chats.participants.add(chatId, { handle });
        } catch (error) {
          throw translateLinqError(error, {
            action: "add group chat participant",
            resourceId: chatId,
            resourceType: "chat",
          });
        }
      },
      removeParticipant: async (handle: string): Promise<void> => {
        validateParticipantHandle(handle);
        validateKnownGroup(isGroup);
        const client = await this.getApiClient();

        try {
          await client.chats.participants.remove(chatId, { handle });
        } catch (error) {
          throw translateLinqError(error, {
            action: "remove group chat participant",
            resourceId: chatId,
            resourceType: "chat",
          });
        }
      },
      leave: async (): Promise<void> => {
        validateKnownGroup(isGroup);
        const client = await this.getApiClient();

        try {
          await client.chats.leaveChat(chatId);
        } catch (error) {
          throw translateLinqError(error, {
            action: "leave group chat",
            resourceId: chatId,
            resourceType: "chat",
          });
        }
      },
    });
    const location: LinqLocationConversation = Object.freeze({
      request: async (): Promise<void> => {
        if (isGroup === true) {
          throw validationError("Linq location requests require a direct chat.");
        }
        const client = await this.getApiClient();

        try {
          await client.chats.location.request(chatId);
        } catch (error) {
          throw translateLinqError(error, {
            action: "request chat location",
            resourceId: chatId,
            resourceType: "chat",
          });
        }
      },
      retrieve: async (): Promise<LinqLocationSnapshot> => {
        const client = await this.getApiClient();
        try {
          const response = await client.chats.location.retrieve(chatId);
          return normalizeLocationSnapshot(threadId, response);
        } catch (error) {
          throw translateLinqError(error, {
            action: "retrieve chat location",
            resourceId: chatId,
            resourceType: "chat",
          });
        }
      },
    });

    return Object.freeze({
      threadId,
      group,
      location,
      replyToPart: async (
        messageId: string,
        partIndex: number,
        content: AdapterPostableMessage,
      ): Promise<SentMessage> => {
        validateMessageId(messageId);
        validatePartIndex(partIndex);
        validatePostableContent(content);

        return thread.reply(messageId, withLinqReplyPartIndex(content, partIndex));
      },
      addReaction: async (
        messageId: string,
        reaction: string,
        options?: LinqPartReactionOptions,
      ): Promise<void> => {
        await this.reactToMessagePart(threadId, messageId, reaction, "add", options);
      },
      removeReaction: async (
        messageId: string,
        reaction: string,
        options?: LinqPartReactionOptions,
      ): Promise<void> => {
        await this.reactToMessagePart(threadId, messageId, reaction, "remove", options);
      },
      stopTyping: async (): Promise<void> => {
        const client = await this.getApiClient();
        try {
          await client.chats.typing.stop(chatId);
        } catch (error) {
          throw translateLinqError(error, {
            action: "stop chat typing",
            resourceId: chatId,
            resourceType: "chat",
          });
        }
      },
      shareContactCard: async (): Promise<void> => {
        const client = await this.getApiClient();
        try {
          await client.chats.shareContactCard(chatId);
        } catch (error) {
          throw translateLinqError(error, {
            action: "share chat contact card",
            resourceId: chatId,
            resourceType: "chat",
          });
        }
      },
      sendVoiceMemo: async (source: LinqVoiceMemoSource): Promise<LinqVoiceMemoResult> => {
        const request = normalizeVoiceMemoSource(source);
        const client = await this.getApiClient();

        try {
          const response = await client.chats.sendVoicememo(chatId, request);
          const voiceMemo = response.voice_memo;

          return Object.freeze({
            messageId: voiceMemo.id,
            threadId: this.encodeThreadId({
              chatId: voiceMemo.chat.id,
              isGroup: voiceMemo.chat.is_group,
            }),
            attachmentId: voiceMemo.voice_memo.id,
          });
        } catch (error) {
          throw translateLinqError(error, {
            action: "send chat voice memo",
            resourceId: chatId,
            resourceType: "chat",
          });
        }
      },
    });
  }

  onLinqEvent<TType extends LinqKnownEventType>(
    type: TType,
    handler: LinqEventHandler<LinqEventMap[TType]>,
  ): () => void;
  onLinqEvent<TType extends LinqKnownEventType>(
    types: readonly TType[],
    handler: LinqEventHandler<LinqEventMap[TType]>,
  ): () => void;
  onLinqEvent(handler: LinqEventHandler<LinqAnyEvent>): () => void;
  onLinqEvent(
    typeOrHandler: LinqKnownEventType | readonly LinqKnownEventType[] | LinqEventHandler,
    handler?: LinqEventHandler,
  ): () => void {
    if (typeof typeOrHandler === "function") {
      if (handler !== undefined) {
        throw new TypeError("onLinqEvent all-event registration accepts one handler");
      }

      return this.linqEvents.subscribe(null, typeOrHandler);
    }

    if (typeof handler !== "function") {
      throw new TypeError("onLinqEvent requires a handler");
    }

    const types = typeof typeOrHandler === "string" ? [typeOrHandler] : typeOrHandler;
    for (const type of types) {
      if (!isLinqKnownEventType(type)) {
        throw new TypeError(`Unsupported Linq event type: ${type}`);
      }
    }

    return this.linqEvents.subscribe(types, handler);
  }

  /** Subscribe to the released delivery-status compatibility view. */
  onDeliveryStatus(listener: LinqDeliveryStatusListener): () => void {
    this.deliveryStatusListeners.add(listener);

    return () => {
      this.deliveryStatusListeners.delete(listener);
    };
  }

  // Thread ID
  //
  // The encoded form is always `linq:{chatId}` so the same Linq chat maps to the
  // same Chat SDK thread no matter which path (webhook, fetch, send) produced it.
  // Group/DM identity lives in `chatKinds` instead of the thread ID.
  encodeThreadId(platformData: LinqThreadId): string {
    if (platformData.pendingHandle) {
      return `linq:pending:${platformData.pendingHandle}`;
    }

    if (platformData.isGroup !== undefined) {
      this.chatKinds.set(platformData.chatId, platformData.isGroup);
    }

    return `linq:${platformData.chatId}`;
  }

  decodeThreadId(threadId: string): LinqThreadId {
    const [adapterName, chatId, kind] = threadId.split(":");

    if (adapterName !== "linq" || !chatId) {
      throw new Error(`Invalid Linq thread ID: ${threadId}`);
    }

    if (chatId === "pending") {
      const pendingHandle = threadId.slice("linq:pending:".length);
      if (!pendingHandle) {
        throw new Error(`Invalid Linq thread ID: ${threadId}`);
      }

      return { chatId: "", pendingHandle, isGroup: false };
    }

    // Older adapter versions encoded group/dm into the thread ID. Keep decoding
    // those so persisted thread IDs survive the format change.
    if (kind === "group" || kind === "dm") {
      const isGroup = kind === "group";
      this.chatKinds.set(chatId, isGroup);

      return { chatId, isGroup };
    }

    if (kind !== undefined) {
      throw new Error(`Invalid Linq thread ID: ${threadId}`);
    }

    return { chatId, isGroup: this.chatKinds.get(chatId) };
  }

  /**
   * Opens an upstream-compatible bootstrap thread. Linq creates or reuses the
   * canonical chat only when its first message is accepted.
   */
  async openDM(handle: string): Promise<string> {
    const pendingHandle = handle.trim();
    if (!pendingHandle) {
      throw new Error("Linq openDM requires a handle.");
    }

    return this.encodeThreadId({ chatId: "", pendingHandle, isGroup: false });
  }

  private requireChatId(threadId: string): string {
    const { chatId, pendingHandle } = this.decodeThreadId(threadId);
    if (pendingHandle) {
      throw new Error(
        `Linq thread ${threadId} has no chat yet — send a message first to create it.`,
      );
    }

    return chatId;
  }

  // Messages
  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<LinqRawMessage>> {
    const chatId = this.requireChatId(threadId);

    if (options?.direction === "forward") {
      throw new NotImplementedError("Linq message history does not support forward pagination");
    }

    let cursor = options?.cursor;
    const visitedCursors = new Set<string>();
    let filteredPageCount = 0;
    const client = await this.getApiClient();

    for (;;) {
      let page: Awaited<ReturnType<LinqAPIV3["chats"]["messages"]["list"]>>;
      try {
        page = await client.chats.messages.list(chatId, {
          cursor,
          limit: options?.limit,
        });
      } catch (error) {
        throw translateLinqError(error, {
          action: "list chat messages",
          resourceId: chatId,
          resourceType: "chat",
        });
      }
      const parsedRows: Array<{
        readonly message: Message<LinqRawMessage>;
        readonly providerIndex: number;
        readonly timestamp: number | undefined;
      }> = [];

      for (const [providerIndex, raw] of (Array.isArray(page.messages)
        ? page.messages
        : []
      ).entries()) {
        try {
          parsedRows.push({
            message: this.parseMessage(raw),
            providerIndex,
            timestamp: validProviderMessageTimestamp(raw),
          });
        } catch (error) {
          this.logger.warn("Skipping malformed Linq history row", { error });
        }
      }

      const messages = chronologicalHistoryMessages(parsedRows);

      const nextCursor = page.next_cursor || undefined;

      if (messages.length > 0 || nextCursor === undefined) {
        return { messages, nextCursor };
      }

      // Chat SDK stops iteration on an empty adapter page even when a cursor is
      // present. Skip provider pages whose rows were all malformed so a later
      // usable page is not silently lost, while refusing cursor cycles.
      if (nextCursor === cursor || visitedCursors.has(nextCursor)) {
        this.logger.warn("Stopping Linq history pagination after a repeated cursor", {
          cursor: nextCursor,
        });
        return { messages: [], nextCursor: undefined };
      }

      filteredPageCount += 1;
      if (filteredPageCount >= MAX_CONSECUTIVE_FILTERED_HISTORY_PAGES) {
        this.logger.warn("Stopping Linq history pagination after too many filtered pages", {
          count: filteredPageCount,
        });
        return { messages: [], nextCursor: undefined };
      }

      visitedCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  async fetchMessage(threadId: string, messageId: string): Promise<Message<LinqRawMessage> | null> {
    const chatId = this.requireChatId(threadId);
    const client = await this.getApiClient();

    let message: Awaited<ReturnType<LinqAPIV3["messages"]["retrieve"]>>;
    try {
      message = await client.messages.retrieve(messageId);
    } catch (error) {
      if (isRecord(error) && error.status === 404) {
        return null;
      }

      throw translateLinqError(error, {
        action: "retrieve message",
        resourceId: messageId,
        resourceType: "message",
      });
    }

    // Linq retrieves messages by globally unique provider ID. Preserve Chat
    // SDK's thread-scoped fetch contract if a caller supplies an ID from a
    // different chat.
    if (message.chat_id !== chatId) {
      return null;
    }

    return this.parseMessage(message);
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LinqRawMessage>> {
    return this.sendMessage(threadId, message);
  }

  async reply(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LinqRawMessage>> {
    const partIndex = getLinqReplyPartIndex(message);

    return this.sendMessage(threadId, message, {
      message_id: messageId,
      ...(partIndex === undefined ? {} : { part_index: partIndex }),
    });
  }

  private async sendMessage(
    threadId: string,
    message: AdapterPostableMessage,
    replyTo?: { message_id: string; part_index?: number },
  ): Promise<RawMessage<LinqRawMessage>> {
    const { chatId, pendingHandle } = this.decodeThreadId(threadId);
    const compiledText = compileLinqMessageText(message);
    const sendOptions = compileLinqSendOptions(message);
    const card = extractCardElement(message);
    const cardImageUrls = card ? collectCardImageUrls(card) : [];
    const plan = planLinqOutboundMessage(
      message,
      compiledText,
      cardImageUrls,
      sendOptions.richLink,
    );
    if (pendingHandle && replyTo) {
      throw validationError("Linq pending threads cannot reply before their chat exists.");
    }
    const idempotencyKey = randomUUID();

    if (card) {
      // Feedback instead of silence: the card still sends, but its buttons and
      // selects are text labels — the poster's onAction() handlers can't fire.
      if (cardHasInteractiveActions(card)) {
        this.logger.warn(
          "Card buttons/selects were flattened to text — onAction() handlers never fire over iMessage/SMS. " +
            "Use LinkButton/CardLink URLs or handle plain-text replies instead.",
        );
      }
    }

    const createdAttachmentIds: string[] = [];
    let messageSendingBegan = false;
    const client = await this.getApiClient();

    try {
      const parts = await prepareLinqOutboundParts(client, plan, (attachmentId) => {
        createdAttachmentIds.push(attachmentId);
      });

      // Once send begins, Linq may have accepted attachment references even if
      // the client ultimately throws, so preparation cleanup must stop here.
      messageSendingBegan = true;
      const messageContent = {
        idempotency_key: idempotencyKey,
        parts,
        ...(sendOptions.preferredService
          ? { preferred_service: sendOptions.preferredService }
          : {}),
        ...(sendOptions.effect ? { effect: { ...sendOptions.effect } } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
      };
      const response = pendingHandle
        ? await client.messages.create({ to: [pendingHandle], message: messageContent })
        : await client.chats.messages.send(chatId, { message: messageContent });

      return {
        id: response.message.id,
        threadId: this.encodeThreadId({ chatId: response.chat_id || chatId }),
        raw: response,
      };
    } catch (error) {
      if (!messageSendingBegan) {
        await this.cleanupPreparedAttachments(client, createdAttachmentIds);
      }

      throw translateLinqError(error, {
        action: messageSendingBegan ? "send messages" : "prepare attachments",
        resourceId: messageSendingBegan ? chatId : undefined,
        resourceType: messageSendingBegan ? "chat" : "attachment",
      });
    }
  }

  private async cleanupPreparedAttachments(
    client: LinqAPIV3,
    attachmentIds: string[],
  ): Promise<void> {
    await Promise.allSettled(
      attachmentIds.map(async (attachmentId) => {
        await client.attachments.delete(attachmentId);
      }),
    );
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LinqRawMessage>> {
    const { text } = compileLinqMessageText(message);

    if (!text) {
      throw validationError("Linq message text cannot be empty.");
    }
    const chatId = this.requireChatId(threadId);
    const client = await this.getApiClient();

    let response: Awaited<ReturnType<LinqAPIV3["messages"]["update"]>>;
    try {
      response = await client.messages.update(messageId, {
        text,
        part_index: 0,
      });
    } catch (error) {
      throw translateLinqError(error, {
        action: "edit message",
        resourceId: messageId,
        resourceType: "message",
      });
    }

    return {
      id: response.id,
      threadId: this.encodeThreadId({ chatId: response.chat_id || chatId }),
      raw: response,
    };
  }

  deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new NotImplementedError("deleteMessage is not implemented");
  }

  // Reactions
  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    validateStandardReaction(emoji);
    this.requireChatId(threadId);
    const client = await this.getApiClient();

    try {
      await client.messages.addReaction(messageId, {
        operation: "add",
        ...toLinqReaction(emoji),
      });
    } catch (error) {
      throw translateLinqError(error, {
        action: "add message reaction",
        resourceId: messageId,
        resourceType: "message",
      });
    }
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    validateStandardReaction(emoji);
    this.requireChatId(threadId);
    const client = await this.getApiClient();

    try {
      await client.messages.addReaction(messageId, {
        operation: "remove",
        ...toLinqReaction(emoji),
      });
    } catch (error) {
      throw translateLinqError(error, {
        action: "remove message reaction",
        resourceId: messageId,
        resourceType: "message",
      });
    }
  }

  private resolveConversationThread(threadOrId: Thread | string): Thread {
    if (typeof threadOrId === "string") {
      validateCanonicalThreadId(threadOrId);
      if (!this.chat) {
        throw validationError("Linq conversations require an initialized Chat instance.");
      }

      return this.chat.thread(threadOrId);
    }

    if (!isRecord(threadOrId)) {
      throw validationError("Linq conversations require a Thread or canonical thread ID.");
    }
    const thread = threadOrId as unknown as Thread;

    if (thread.adapter !== this) {
      throw validationError("Linq conversation threads must belong to this adapter instance.");
    }
    validateCanonicalThreadId(thread.id);

    return thread;
  }

  private async reactToMessagePart(
    threadId: string,
    messageId: string,
    reaction: string,
    operation: "add" | "remove",
    options?: LinqPartReactionOptions,
  ): Promise<void> {
    validateCanonicalThreadId(threadId);
    validateMessageId(messageId);
    validateReaction(reaction);
    if (options?.partIndex !== undefined) {
      validatePartIndex(options.partIndex);
    }
    const client = await this.getApiClient();

    try {
      await client.messages.addReaction(messageId, {
        operation,
        ...toLinqReaction(reaction),
        ...(options?.partIndex === undefined ? {} : { part_index: options.partIndex }),
      });
    } catch (error) {
      throw translateLinqError(error, {
        action: `${operation} message reaction`,
        resourceId: messageId,
        resourceType: "message",
      });
    }
  }

  // Threads
  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const chatId = this.requireChatId(threadId);
    const client = await this.getApiClient();
    let chat: Awaited<ReturnType<LinqAPIV3["chats"]["retrieve"]>>;
    try {
      chat = await client.chats.retrieve(chatId);
    } catch (error) {
      throw translateLinqError(error, {
        action: "retrieve chat",
        resourceId: chatId,
        resourceType: "chat",
      });
    }

    return {
      id: this.encodeThreadId({ chatId: chat.id, isGroup: chat.is_group }),
      channelId: this.encodeThreadId({ chatId: chat.id, isGroup: chat.is_group }),
      channelName: chat.display_name ?? undefined,
      isDM: !chat.is_group,
      metadata: {
        chat,
      },
    };
  }

  async startTyping(threadId: string, _status?: string): Promise<void> {
    const chatId = this.requireChatId(threadId);
    if (!UUID_PATTERN.test(chatId)) {
      throw validationError("Linq typing requires a valid chat UUID.");
    }
    const client = await this.getApiClient();

    try {
      await client.chats.typing.start(chatId);
    } catch (error) {
      throw translateLinqError(error, {
        action: "start chat typing",
        resourceId: chatId,
        resourceType: "chat",
      });
    }
  }

  /** Linq acknowledges the whole chat; the Chat SDK message arguments are intentionally advisory. */
  async markAsRead(
    threadId: string,
    _messageId: string,
    _message?: Message<LinqRawMessage>,
  ): Promise<void> {
    const chatId = this.requireChatId(threadId);
    const client = await this.getApiClient();

    try {
      await client.chats.markAsRead(chatId);
    } catch (error) {
      throw translateLinqError(error, {
        action: "mark chat as read",
        resourceId: chatId,
        resourceType: "chat",
      });
    }
  }

  /** Released compatibility alias; prefer Chat SDK `Thread.markAsRead()`. */
  async markRead(threadId: string, messageId: string): Promise<void> {
    return this.markAsRead(threadId, messageId);
  }

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
  ): Promise<RawMessage<LinqRawMessage>> {
    let text = "";

    for await (const chunk of textStream) {
      if (typeof chunk === "string") {
        text += chunk;
        continue;
      }

      if (chunk.type === "markdown_text") {
        text += chunk.text;
      }
    }

    return this.postMessage(threadId, text.trim() ? { markdown: text } : " ");
  }

  /** Verify, parse, and normalize one Linq webhook without dispatching it. */
  async verifyWebhook(request: Request): Promise<LinqWebhookVerificationResult> {
    return (await this.verifyWebhookRequest(request)).result;
  }

  /**
   * Enter Chat SDK dispatch for this adapter's verified result. Downstream
   * completion follows Chat SDK and WebhookOptions.waitUntil semantics.
   */
  async dispatchVerifiedWebhook(
    webhook: LinqVerifiedWebhook,
    options?: WebhookOptions,
  ): Promise<LinqVerifiedWebhookDispatchResult> {
    const event = getVerifiedLinqWebhookEvent(webhook, this.webhookVerificationAuthority);
    const includeNamed =
      webhook.envelope.versionStatus === "current" && webhook.kind !== "unhandled";
    const genericHandlers = this.linqEvents.handlersFor(webhook.envelope.eventType, includeNamed);

    if (this.state) {
      const claimed = await this.state.setIfNotExists(
        `dedupe:linq:event:${webhook.envelope.partnerId}:${webhook.envelope.eventId}`,
        true,
        LINQ_EVENT_DEDUPE_TTL_MS,
      );

      if (!claimed) {
        this.logger.debug("Skipping duplicate Linq event", {
          eventType: webhook.envelope.eventType,
        });
        return { handled: "ignored" };
      }
    } else if (genericHandlers.length > 0) {
      throw new Error("Linq event handlers require an initialized Chat instance");
    }

    const genericDispatch = this.dispatchGenericLinqEvent(webhook, genericHandlers);

    this.dispatchDeliveryStatus(webhook);

    if (genericHandlers.length > 0 && options?.waitUntil) {
      options.waitUntil(genericDispatch);
    }

    // A current known event with an authenticated envelope but an unusable
    // curated payload remains losslessly observable without entering a named
    // or standard handler that would require guessing missing facts.
    if (webhook.kind === "unhandled") {
      return { handled: "ignored" };
    }

    if (webhook.envelope.versionStatus === "older") {
      return this.dispatchCompatibilityWebhook(event, options);
    }

    if (webhook.envelope.versionStatus === "current") {
      return this.dispatchWebhookEvent(event, options);
    }

    return { handled: "ignored" };
  }

  private dispatchDeliveryStatus(webhook: LinqVerifiedWebhook): void {
    let delivery: LinqDeliveryStatusEvent | null = null;

    if (
      (webhook.kind === "message.sent" ||
        webhook.kind === "message.delivered" ||
        webhook.kind === "message.read") &&
      webhook.lifecycle.direction === "outbound"
    ) {
      delivery = Object.freeze({
        status:
          webhook.kind === "message.sent"
            ? "sent"
            : webhook.kind === "message.delivered"
              ? "delivered"
              : "read",
        threadId: this.encodeThreadId({ chatId: webhook.lifecycle.chatId }),
        messageId: webhook.lifecycle.providerMessageId,
        raw: webhook.rawEvent,
      });
    } else if (
      webhook.kind === "message.failed" &&
      webhook.failure.chatId &&
      webhook.failure.providerMessageId
    ) {
      delivery = Object.freeze({
        status: "failed",
        threadId: this.encodeThreadId({ chatId: webhook.failure.chatId }),
        messageId: webhook.failure.providerMessageId,
        error: Object.freeze({
          code: webhook.failure.code,
          ...(webhook.failure.reason === null ? {} : { message: webhook.failure.reason }),
        }),
        raw: webhook.rawEvent,
      });
    }

    if (!delivery) {
      return;
    }

    const listeners = Array.from(this.deliveryStatusListeners);
    for (const listener of listeners) {
      try {
        const completion = listener(delivery);
        if (completion != null) {
          void Promise.resolve(completion).catch((error: unknown) => {
            this.logger.warn("Linq delivery-status listener failed", {
              error,
              eventType: webhook.envelope.eventType,
            });
          });
        }
      } catch (error) {
        this.logger.warn("Linq delivery-status listener failed", {
          error,
          eventType: webhook.envelope.eventType,
        });
      }
    }
  }

  private async dispatchGenericLinqEvent(
    webhook: LinqVerifiedWebhook,
    handlers: readonly LinqEventHandler[],
  ): Promise<void> {
    if (handlers.length === 0) {
      return;
    }

    const event = createLinqEvent(webhook);
    const results = await Promise.allSettled(
      handlers.map((handler) => Promise.resolve().then(() => handler(event))),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.error("Linq event handler failed", {
          error: result.reason,
          eventType: webhook.envelope.eventType,
        });
      }
    }
  }

  // Ordinary one-step Chat SDK webhook entry point.
  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const verification = await this.verifyWebhookRequest(request);

    if (verification.result.ok) {
      await this.dispatchVerifiedWebhook(verification.result.webhook, options);
      return new Response("OK", { status: 200 });
    }

    return responseForLinqWebhookFailure(verification.result);
  }

  private async verifyWebhookRequest(request: Request): Promise<{
    result: LinqWebhookVerificationResult;
  }> {
    let authentication: LinqWebhookAuthenticationResult;
    if (this.webhookVerifier) {
      authentication = await authenticateTrustedLinqWebhookRequest(request, this.webhookVerifier);
    } else {
      let signingSecret: string;
      try {
        signingSecret = await this.getSigningSecret();
      } catch {
        return {
          result: failure(
            "missing_signing_secret",
            503,
            "Linq webhook signing secret is not configured",
          ),
        };
      }
      authentication = await authenticateLinqWebhookRequest(request, signingSecret);
    }

    if (!authentication.ok) {
      return { result: authentication };
    }

    return {
      result: normalizeAuthenticatedLinqWebhook(
        authentication.event,
        authentication.transport,
        authentication.rawBody,
        authentication.rawBodyBase64,
        this.webhookVerificationAuthority,
      ),
    };
  }

  private async dispatchWebhookEvent(
    event: LinqWebhookEvent,
    options?: WebhookOptions,
  ): Promise<LinqVerifiedWebhookDispatchResult> {
    if (
      this.chat &&
      isMessageReceivedWebhookEvent(event) &&
      event.data.direction === "inbound" &&
      event.data.reconciled_at === undefined
    ) {
      const chatId = event.data.chat.id;
      const isGroup = event.data.chat.is_group ?? this.chatKinds.get(chatId);

      // A malformed event without a canonical or previously observed chat kind
      // remains available through the verified Linq event seam. Do not add
      // provider I/O to the acknowledgement path or guess the standard handler.
      if (isGroup === undefined) {
        return { handled: "ignored" };
      }

      const threadId = this.encodeThreadId({ chatId, isGroup });

      const factory = async (): Promise<Message<unknown>> => {
        const msg = this.parseMessage(event.data);

        return msg;
      };

      this.chat.processMessage(this, threadId, factory, options);
      return { handled: "message" };
    } else if (this.chat && isReactionWebhookEvent(event)) {
      this.processReactionWebhook(this.chat, event, options);
      return { handled: "reaction" };
    }

    return { handled: "ignored" };
  }

  private async dispatchCompatibilityWebhook(
    event: unknown,
    options?: WebhookOptions,
  ): Promise<LinqVerifiedWebhookDispatchResult> {
    if (isCompatibilityMessageReceivedEvent(event)) {
      return this.dispatchWebhookEvent(event, options);
    }

    if (isCompatibilityReactionEvent(event)) {
      return this.dispatchWebhookEvent(event, options);
    }

    return { handled: "ignored" };
  }

  private processReactionWebhook(
    chat: ChatInstance,
    event: LinqReactionWebhookEvent,
    options?: WebhookOptions,
  ): void {
    const { chat_id: chatId, message_id: messageId } = event.data;

    if (!chatId || !messageId) {
      this.logger.debug(`Ignoring Linq ${event.event_type} webhook without chat/message ID`);

      return;
    }

    const reaction = fromLinqReaction(event.data);

    if (!reaction) {
      this.logger.debug(
        `Ignoring Linq ${event.event_type} webhook with unsupported reaction type ${event.data.reaction_type}`,
      );

      return;
    }

    const handle = event.data.from_handle;
    const isMe = event.data.is_from_me || handle?.is_me === true;
    const senderId = handle?.id || handle?.handle || event.data.from || "unknown";
    const senderName = handle?.handle || event.data.from || senderId;

    chat.processReaction(
      {
        adapter: this,
        added: event.event_type === "reaction.added",
        emoji: reaction.emoji,
        rawEmoji: reaction.rawEmoji,
        messageId,
        threadId: this.encodeThreadId({ chatId }),
        raw: event,
        user: {
          userId: senderId,
          userName: senderName,
          fullName: senderName,
          isBot: isMe,
          isMe,
        },
      },
      options,
    );
  }

  parseMessage(raw: LinqRawMessage): Message<LinqRawMessage> {
    return parseLinqMessage(
      raw,
      (platformData) => this.encodeThreadId(platformData),
      async () => (await this.getApiClient()).attachments,
    );
  }

  // Rebuild fetchData from the stable provider attachment ID after serialization.
  // A fresh CDN URL is resolved only when bytes are requested.
  rehydrateAttachment(attachment: Attachment): Attachment {
    const attachmentId = attachment.fetchMetadata?.attachmentId;

    if (
      !attachmentId ||
      !attachment.name ||
      !attachment.mimeType ||
      attachment.size === undefined
    ) {
      return attachment;
    }

    return {
      ...attachment,
      fetchData: createLinqAttachmentFetcher(async () => (await this.getApiClient()).attachments, {
        attachmentId,
        filename: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.size,
      }),
    };
  }

  // Random
  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content).trim();
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  isDM(threadId: string): boolean {
    // Only report a DM when we have seen the chat and know it is not a group.
    // Canonical webhooks and fetched chats warm this before handlers run.
    return this.decodeThreadId(threadId).isGroup === false;
  }
}

function validProviderMessageTimestamp(raw: unknown): number | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  for (const candidate of [raw.sent_at, raw.created_at]) {
    if (typeof candidate !== "string" || !isValidProviderTimestamp(candidate)) {
      continue;
    }

    return Date.parse(candidate);
  }

  return undefined;
}

function chronologicalHistoryMessages(
  rows: readonly {
    readonly message: Message<LinqRawMessage>;
    readonly providerIndex: number;
    readonly timestamp: number | undefined;
  }[],
): Message<LinqRawMessage>[] {
  const chronological = rows
    .filter(
      (row): row is typeof row & { readonly timestamp: number } => row.timestamp !== undefined,
    )
    .sort(
      (left, right) => left.timestamp - right.timestamp || left.providerIndex - right.providerIndex,
    );
  let chronologicalIndex = 0;

  // Keep unusable timestamp rows in their provider-relative slots. Only rows
  // with truthful provider timestamps participate in chronological ordering.
  return rows.map((row) =>
    row.timestamp === undefined
      ? row.message
      : (chronological[chronologicalIndex++]?.message ?? row.message),
  );
}

export function createLinqAdapter(config: LinqAdapterConfig): LinqAdapter {
  return new LinqAdapter(config);
}

function isCompatibilityMessageReceivedEvent(
  event: unknown,
): event is LinqMessageReceivedWebhookEvent {
  if (!isRecord(event) || event.event_type !== "message.received" || !isRecord(event.data)) {
    return false;
  }

  const data = event.data;
  return (
    (data.direction === "inbound" || data.direction === "outbound") &&
    typeof data.id === "string" &&
    (Array.isArray(data.parts) || data.parts === null) &&
    isRecord(data.chat) &&
    typeof data.chat.id === "string" &&
    isRecord(data.sender_handle)
  );
}

function isCompatibilityReactionEvent(event: unknown): event is LinqReactionWebhookEvent {
  return (
    isRecord(event) &&
    (event.event_type === "reaction.added" || event.event_type === "reaction.removed") &&
    isRecord(event.data) &&
    typeof event.data.is_from_me === "boolean" &&
    typeof event.data.reaction_type === "string"
  );
}

function validateCanonicalThreadId(threadId: string): void {
  const match = /^linq:([^:]+)$/.exec(threadId);
  if (!match?.[1] || !UUID_PATTERN.test(match[1])) {
    throw validationError("Linq conversations require a canonical linq:{chat UUID} thread ID.");
  }
}

function validateMessageId(messageId: string): void {
  if (!UUID_PATTERN.test(messageId)) {
    throw validationError("Linq message IDs must be UUIDs.");
  }
}

function validatePartIndex(partIndex: number): void {
  if (!Number.isInteger(partIndex) || partIndex < 0) {
    throw validationError("Linq message part indexes must be non-negative integers.");
  }
}

function validateReaction(reaction: string): void {
  if (typeof reaction !== "string" || reaction.trim().length === 0) {
    throw validationError("Linq reactions must be non-empty strings.");
  }
}

function validateStandardReaction(reaction: EmojiValue | string): void {
  validateReaction(typeof reaction === "string" ? reaction : reaction.name);
}

function validatePostableContent(content: AdapterPostableMessage): void {
  if (typeof content !== "string" && !isRecord(content)) {
    throw validationError("Linq replies require valid Chat SDK message content.");
  }
}

type LinqVoiceMemoRequest = { voice_memo_url: string } | { attachment_id: string };

function normalizeVoiceMemoSource(source: unknown): LinqVoiceMemoRequest {
  if (!isRecord(source)) {
    throw validationError("Linq voice memos require exactly one URL or attachment ID source.");
  }

  const hasUrl = Object.prototype.hasOwnProperty.call(source, "url");
  const hasAttachmentId = Object.prototype.hasOwnProperty.call(source, "attachmentId");
  if (hasUrl === hasAttachmentId) {
    throw validationError("Linq voice memos require exactly one URL or attachment ID source.");
  }

  if (hasUrl) {
    const value = source.url;
    if (typeof value !== "string" && !(value instanceof URL)) {
      throw validationError("Linq voice memo URLs must be valid public HTTPS URLs.");
    }

    const url = typeof value === "string" ? value : value.href;
    if (url.length === 0 || (typeof value === "string" && value.trim() !== value)) {
      throw validationError("Linq voice memo URLs must be valid public HTTPS URLs.");
    }

    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" && parsed.hostname.length > 0) {
        return { voice_memo_url: url };
      }
    } catch {
      // Fall through to the stable adapter validation error.
    }

    throw validationError("Linq voice memo URLs must be valid public HTTPS URLs.");
  }

  const attachmentId = source.attachmentId;
  if (
    typeof attachmentId !== "string" ||
    attachmentId.trim() !== attachmentId ||
    !UUID_PATTERN.test(attachmentId)
  ) {
    throw validationError("Linq voice memo attachment IDs must be UUIDs.");
  }

  return { attachment_id: attachmentId };
}

type LinqGroupUpdateRequest = {
  display_name?: string;
  group_chat_icon?: string;
};

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
    request.group_chat_icon = normalizePublicHTTPSURL(
      options.iconUrl,
      "Linq group icons must be valid public HTTPS URLs.",
    );
  }

  if (request.display_name === undefined && request.group_chat_icon === undefined) {
    throw validationError("Linq group updates require a displayName or iconUrl.");
  }

  return request;
}

function validateParticipantHandle(handle: unknown): asserts handle is string {
  if (typeof handle !== "string" || handle.trim() !== handle) {
    throw validationError(
      "Linq participant handles must be E.164 phone numbers or email addresses.",
    );
  }

  const isE164 = /^\+[1-9]\d{1,14}$/.test(handle);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(handle);
  if (!isE164 && !isEmail) {
    throw validationError(
      "Linq participant handles must be E.164 phone numbers or email addresses.",
    );
  }
}

function validateKnownGroup(isGroup: boolean | undefined): void {
  if (isGroup === false) {
    throw validationError("Linq group operations require a group chat.");
  }
}

function normalizeLocationSnapshot(threadId: string, response: unknown): LinqLocationSnapshot {
  const features =
    isRecord(response) &&
    response.success === true &&
    isRecord(response.data) &&
    response.data.type === "FeatureCollection" &&
    Array.isArray(response.data.features)
      ? response.data.features
      : [];
  const locations = features.flatMap((feature): LinqSharedLocation[] => {
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
      properties.handle.length === 0
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
    if (typeof properties.address === "string") {
      location.address = properties.address;
    }
    if (typeof properties.locality === "string") {
      location.locality = properties.locality;
    }
    if (
      typeof properties.updated_at === "string" &&
      isValidProviderTimestamp(properties.updated_at)
    ) {
      location.updatedAt = properties.updated_at;
    }

    return [Object.freeze(location)];
  });

  return Object.freeze({ threadId, locations: Object.freeze(locations) });
}

function isValidProviderTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function normalizePublicHTTPSURL(value: unknown, message: string): string {
  if (typeof value !== "string" && !(value instanceof URL)) {
    throw validationError(message);
  }

  const url = typeof value === "string" ? value : value.href;
  if (url.length === 0 || (typeof value === "string" && value.trim() !== value)) {
    throw validationError(message);
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && parsed.hostname.length > 0) {
      return url;
    }
  } catch {
    // Fall through to the stable adapter validation error.
  }

  throw validationError(message);
}

function validationError(message: string): ValidationError {
  return new ValidationError("linq", message);
}
