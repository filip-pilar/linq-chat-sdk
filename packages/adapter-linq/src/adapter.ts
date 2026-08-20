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
import { authenticateLinqWebhookRequest } from "./verification.js";
import {
  getVerifiedLinqWebhookEvent,
  normalizeAuthenticatedLinqWebhook,
  responseForLinqWebhookFailure,
  type LinqVerifiedWebhook,
  type LinqVerifiedWebhookDispatchResult,
  type LinqMessageReceivedWebhookEvent,
  type LinqReactionWebhookEvent,
  type LinqWebhookEvent,
  type LinqWebhookVerificationResult,
  type LinqWebhookVerificationScheme,
} from "./webhook.js";

type LinqThreadId = {
  chatId: string;
  isGroup?: boolean;
};

const LINQ_EVENT_DEDUPE_TTL_MS = 60 * 60 * 1000;

export interface LinqAdapterConfig {
  apiKey: string;
  baseURL?: string;
  signingSecret: string;
  /** Standard by default. Legacy is deprecated and requires explicit opt-in. */
  webhookVerificationMode?: LinqWebhookVerificationScheme;
}

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class LinqAdapter implements Adapter<LinqThreadId, LinqRawMessage> {
  readonly name: string = "linq";
  readonly userName: string = "linq";
  private readonly apiClient: LinqAPIV3;
  private readonly signingSecret: string;
  private readonly webhookVerificationMode: LinqWebhookVerificationScheme;
  private readonly webhookVerificationAuthority = {};
  private readonly linqEvents = new LinqEventRegistry();

  private chat: ChatWithThreads | null = null;
  private state: StateAdapter | null = null;
  private logger: Logger;
  // chatId -> isGroup, learned from webhooks, fetchThread, and legacy thread IDs.
  private readonly chatKinds = new Map<string, boolean>();

  constructor(config: LinqAdapterConfig) {
    if (
      config.webhookVerificationMode !== undefined &&
      config.webhookVerificationMode !== "standard" &&
      config.webhookVerificationMode !== "legacy"
    ) {
      throw new TypeError('webhookVerificationMode must be "standard" or "legacy"');
    }

    this.apiClient = new LinqAPIV3({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.signingSecret = config.signingSecret;
    this.webhookVerificationMode = config.webhookVerificationMode ?? "standard";
    this.logger = new ConsoleLogger();
  }

  get client(): LinqAPIV3 {
    return this.apiClient;
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

        try {
          await this.apiClient.chats.update(chatId, request);
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

        try {
          await this.apiClient.chats.participants.add(chatId, { handle });
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

        try {
          await this.apiClient.chats.participants.remove(chatId, { handle });
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

        try {
          await this.apiClient.chats.leaveChat(chatId);
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
        throw new NotImplementedError("Linq location requests are not implemented");
      },
      retrieve: async (): Promise<LinqLocationSnapshot> => {
        throw new NotImplementedError("Linq location retrieval is not implemented");
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
        try {
          await this.apiClient.chats.typing.stop(chatId);
        } catch (error) {
          throw translateLinqError(error, {
            action: "stop chat typing",
            resourceId: chatId,
            resourceType: "chat",
          });
        }
      },
      shareContactCard: async (): Promise<void> => {
        try {
          await this.apiClient.chats.shareContactCard(chatId);
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

        try {
          const response = await this.apiClient.chats.sendVoicememo(chatId, request);
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

  // Thread ID
  //
  // The encoded form is always `linq:{chatId}` so the same Linq chat maps to the
  // same Chat SDK thread no matter which path (webhook, fetch, send) produced it.
  // Group/DM identity lives in `chatKinds` instead of the thread ID.
  encodeThreadId(platformData: LinqThreadId): string {
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

  // Messages
  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<LinqRawMessage>> {
    const { chatId } = this.decodeThreadId(threadId);

    if (options?.direction === "forward") {
      throw new NotImplementedError("Linq message history does not support forward pagination");
    }

    const page = await this.apiClient.chats.messages.list(chatId, {
      cursor: options?.cursor,
      limit: options?.limit,
    });
    const messages: Message<LinqRawMessage>[] = [];

    for (const raw of Array.isArray(page.messages) ? page.messages : []) {
      try {
        messages.push(this.parseMessage(raw));
      } catch (error) {
        this.logger.warn("Skipping malformed Linq history row", { error });
      }
    }

    return {
      messages,
      nextCursor: page.next_cursor || undefined,
    };
  }

  async fetchMessage(
    _threadId: string,
    messageId: string,
  ): Promise<Message<LinqRawMessage> | null> {
    try {
      const message = await this.apiClient.messages.retrieve(messageId);

      return this.parseMessage(message);
    } catch (error) {
      if (isRecord(error) && error.status === 404) {
        return null;
      }

      throw error;
    }
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
    const { chatId } = this.decodeThreadId(threadId);
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

    try {
      const parts = await prepareLinqOutboundParts(this.apiClient, plan, (attachmentId) => {
        createdAttachmentIds.push(attachmentId);
      });

      // Once send begins, Linq may have accepted attachment references even if
      // the client ultimately throws. Batch 012 owns any send-time lifecycle.
      messageSendingBegan = true;
      const response = await this.apiClient.chats.messages.send(chatId, {
        message: {
          idempotency_key: idempotencyKey,
          parts,
          ...(sendOptions.preferredService
            ? { preferred_service: sendOptions.preferredService }
            : {}),
          ...(sendOptions.effect ? { effect: { ...sendOptions.effect } } : {}),
          ...(replyTo ? { reply_to: replyTo } : {}),
        },
      });

      return {
        id: response.message.id,
        threadId: this.encodeThreadId({ chatId: response.chat_id || chatId }),
        raw: response,
      };
    } catch (error) {
      if (!messageSendingBegan) {
        await this.cleanupPreparedAttachments(createdAttachmentIds);
      }

      throw translateLinqError(error, {
        action: messageSendingBegan ? "send messages" : "prepare attachments",
        resourceId: messageSendingBegan ? chatId : undefined,
        resourceType: messageSendingBegan ? "chat" : "attachment",
      });
    }
  }

  private async cleanupPreparedAttachments(attachmentIds: string[]): Promise<void> {
    await Promise.allSettled(
      attachmentIds.map(async (attachmentId) => {
        await this.apiClient.attachments.delete(attachmentId);
      }),
    );
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LinqRawMessage>> {
    const { chatId } = this.decodeThreadId(threadId);
    const { text } = compileLinqMessageText(message);

    if (!text) {
      throw new Error("Linq message text cannot be empty.");
    }

    const response = await this.apiClient.messages.update(messageId, {
      text,
      part_index: 0,
    });

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
    _threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    await this.apiClient.messages.addReaction(messageId, {
      operation: "add",
      ...toLinqReaction(emoji),
    });
  }

  async removeReaction(
    _threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    await this.apiClient.messages.addReaction(messageId, {
      operation: "remove",
      ...toLinqReaction(emoji),
    });
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

    try {
      await this.apiClient.messages.addReaction(messageId, {
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
    const { chatId } = this.decodeThreadId(threadId);
    const chat = await this.apiClient.chats.retrieve(chatId);

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
    const { chatId, isGroup } = this.decodeThreadId(threadId);

    if (isGroup === true) {
      return;
    }

    try {
      await this.apiClient.chats.typing.start(chatId);
    } catch (error) {
      if (isRecord(error) && error.status === 403) {
        return;
      }

      throw error;
    }
  }

  /** Linq acknowledges the whole chat; the Chat SDK message arguments are intentionally advisory. */
  async markAsRead(
    threadId: string,
    _messageId: string,
    _message?: Message<LinqRawMessage>,
  ): Promise<void> {
    const { chatId } = this.decodeThreadId(threadId);

    try {
      await this.apiClient.chats.markAsRead(chatId);
    } catch (error) {
      throw translateLinqError(error, {
        action: "mark chat as read",
        resourceId: chatId,
        resourceType: "chat",
      });
    }
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
    const includeNamed = webhook.envelope.versionStatus === "current";
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

    if (genericHandlers.length > 0 && options?.waitUntil) {
      options.waitUntil(genericDispatch);
    }

    if (webhook.envelope.versionStatus === "older") {
      return this.dispatchCompatibilityWebhook(event, options);
    }

    if (webhook.envelope.versionStatus === "current") {
      return this.dispatchWebhookEvent(event, options);
    }

    return { handled: "ignored" };
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
    const authentication = await authenticateLinqWebhookRequest(
      request,
      this.signingSecret,
      this.webhookVerificationMode,
    );

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
      const isGroup = event.data.chat.is_group ?? undefined;

      // isDM() only trusts known chats, so resolve group/DM identity before
      // dispatching when the webhook does not carry it.
      if (isGroup === undefined && !this.chatKinds.has(chatId)) {
        try {
          const chat = await this.apiClient.chats.retrieve(chatId);

          this.chatKinds.set(chatId, chat.is_group);
        } catch (error) {
          this.logger.warn(`Failed to resolve Linq chat kind for ${chatId}`, { error });
        }
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
      this.apiClient.attachments,
    );
  }

  // Rebuild fetchData from the stable provider attachment ID after queue
  // serialization. A fresh CDN URL is resolved only when bytes are requested.
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
      fetchData: createLinqAttachmentFetcher(this.apiClient.attachments, {
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
    // Webhooks always carry `is_group`, so this is warm before handlers run.
    return this.decodeThreadId(threadId).isGroup === false;
  }
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
