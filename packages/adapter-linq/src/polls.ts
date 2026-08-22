import type { LinqAPIV3 } from "@linqapp/sdk";

import { invalidLinqProviderResponse, linqValidationError as validationError } from "./errors.js";
import { immutableJsonSnapshot, isLinqUuid, isRecord } from "./guards.js";
import { parseLinqTimestamp } from "./timestamps.js";

export interface LinqPollCreateOptions {
  readonly options: readonly string[];
  readonly idempotencyKey?: string;
}

export interface LinqPollVoteInput {
  readonly optionId: string;
  readonly operation: "add" | "remove";
}

export interface LinqPollParticipant {
  readonly id: string;
  readonly handle: string;
  readonly joinedAt: string;
  readonly service: LinqAPIV3.ServiceType;
  readonly isMe: boolean | null;
  readonly leftAt: string | null;
  readonly status: "active" | "left" | "removed" | null;
}

export interface LinqPollVoter {
  readonly handle: string;
  readonly votedAt: string;
}

export interface LinqPollOption {
  readonly optionId: string;
  readonly text: string;
  readonly canBeEdited: boolean;
  readonly creator: LinqPollParticipant | null;
  readonly voters: readonly LinqPollVoter[];
}

export interface LinqPollContent {
  readonly options: readonly LinqPollOption[];
  readonly totalVoters: number;
}

export interface LinqPollSnapshot extends LinqPollContent {
  readonly threadId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly raw: unknown;
}

export interface LinqPollConversation {
  create(input: LinqPollCreateOptions): Promise<LinqPollSnapshot>;
  addOptions(messageId: string, options: readonly string[]): Promise<LinqPollSnapshot>;
  vote(messageId: string, input: LinqPollVoteInput): Promise<LinqPollSnapshot>;
  retrieve(messageId: string): Promise<LinqPollSnapshot>;
}

export function normalizePollCreateInput(value: unknown): {
  readonly options: readonly { readonly text: string }[];
  readonly idempotencyKey?: string;
} {
  if (!isRecord(value) || !Array.isArray(value.options) || value.options.length < 2) {
    throw validationError("Linq polls require at least two options.");
  }

  const options = normalizeOptionInputs(value.options, "Linq poll options");
  const idempotencyKey = normalizeOptionalIdempotencyKey(value.idempotencyKey);
  return Object.freeze({
    options,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
}

export function normalizePollAddOptions(value: unknown): readonly { readonly text: string }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw validationError("Linq poll option updates require at least one option.");
  }

  return normalizeOptionInputs(value, "Linq poll options");
}

export function normalizePollVoteInput(value: unknown): LinqPollVoteInput {
  if (
    !isRecord(value) ||
    !isLinqPollUuid(value.optionId) ||
    (value.operation !== "add" && value.operation !== "remove")
  ) {
    throw validationError("Linq poll votes require a poll option UUID and add/remove operation.");
  }

  return Object.freeze({ optionId: value.optionId, operation: value.operation });
}

export function normalizePollMessageId(value: unknown): string {
  if (!isLinqPollUuid(value)) {
    throw validationError("Linq poll message IDs must be UUIDs.");
  }

  return value;
}

export function normalizePollSnapshot(
  threadId: string,
  chatId: string,
  response: unknown,
  expectedMessageId?: string,
): LinqPollSnapshot {
  if (!isRecord(response) || Array.isArray(response)) {
    throw invalidLinqProviderResponse("read poll response", "response must be an object");
  }
  if (response.chat_id !== chatId) {
    throw invalidLinqProviderResponse("read poll response", "chat_id must match the chat");
  }
  if (
    !isLinqPollUuid(response.message_id) ||
    (expectedMessageId && response.message_id !== expectedMessageId)
  ) {
    throw invalidLinqProviderResponse(
      "read poll response",
      expectedMessageId ? "message_id must match the requested poll" : "message_id must be a UUID",
    );
  }
  if (!isTimestamp(response.created_at) || !isTimestamp(response.updated_at)) {
    throw invalidLinqProviderResponse(
      "read poll response",
      "created_at and updated_at must be RFC3339 timestamps",
    );
  }

  const poll = parsePollContent(response.poll);
  if (!poll) {
    throw invalidLinqProviderResponse("read poll response", "poll must be a valid poll snapshot");
  }

  return Object.freeze({
    threadId,
    messageId: response.message_id,
    createdAt: response.created_at,
    updatedAt: response.updated_at,
    options: poll.options,
    totalVoters: poll.totalVoters,
    raw: immutableJsonSnapshot(response),
  });
}

/** Parse poll content shared by native responses and authenticated webhook projections. */
export function parsePollContent(value: unknown): LinqPollContent | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.options) ||
    !Number.isInteger(value.total_voters) ||
    (value.total_voters as number) < 0
  ) {
    return null;
  }

  const options: LinqPollOption[] = [];
  for (const rawOption of value.options) {
    const option = parsePollOption(rawOption);
    if (!option) return null;
    options.push(option);
  }

  return Object.freeze({
    options: Object.freeze(options),
    totalVoters: value.total_voters as number,
  });
}

export function parsePollOption(value: unknown): LinqPollOption | null {
  if (
    !isRecord(value) ||
    !isLinqPollUuid(value.option_id) ||
    !isNonEmptyString(value.text) ||
    typeof value.can_be_edited !== "boolean" ||
    !Array.isArray(value.voters)
  ) {
    return null;
  }

  const creator = value.creator_handle === null ? null : parsePollParticipant(value.creator_handle);
  if (value.creator_handle !== null && !creator) return null;
  const voters: LinqPollVoter[] = [];
  for (const rawVoter of value.voters) {
    if (
      !isRecord(rawVoter) ||
      !isNonEmptyString(rawVoter.handle) ||
      !isTimestamp(rawVoter.voted_at)
    ) {
      return null;
    }
    voters.push(Object.freeze({ handle: rawVoter.handle, votedAt: rawVoter.voted_at }));
  }

  return Object.freeze({
    optionId: value.option_id,
    text: value.text,
    canBeEdited: value.can_be_edited,
    creator,
    voters: Object.freeze(voters),
  });
}

export function parsePollParticipant(value: unknown): LinqPollParticipant | null {
  if (
    !isRecord(value) ||
    !isLinqPollUuid(value.id) ||
    !isNonEmptyString(value.handle) ||
    !isTimestamp(value.joined_at) ||
    !isService(value.service) ||
    !isNullableBoolean(value.is_me) ||
    !isNullableTimestamp(value.left_at) ||
    !isNullableStatus(value.status)
  ) {
    return null;
  }

  return Object.freeze({
    id: value.id,
    handle: value.handle,
    joinedAt: value.joined_at,
    service: value.service,
    isMe: typeof value.is_me === "boolean" ? value.is_me : null,
    leftAt: typeof value.left_at === "string" ? value.left_at : null,
    status:
      value.status === "active" || value.status === "left" || value.status === "removed"
        ? value.status
        : null,
  });
}

function normalizeOptionInputs(
  values: readonly unknown[],
  label: string,
): readonly { readonly text: string }[] {
  const options = values.map((value) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw validationError(`${label} must be non-empty strings.`);
    }
    return Object.freeze({ text: value });
  });
  return Object.freeze(options);
}

function normalizeOptionalIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("Linq poll idempotency keys must be non-empty strings.");
  }
  return value;
}

export function isLinqPollUuid(value: unknown): value is string {
  return isLinqUuid(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && parseLinqTimestamp(value) !== null;
}

function isNullableTimestamp(value: unknown): boolean {
  return value === undefined || value === null || isTimestamp(value);
}

function isNullableBoolean(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "boolean";
}

function isNullableStatus(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "active" ||
    value === "left" ||
    value === "removed"
  );
}

function isService(value: unknown): value is LinqAPIV3.ServiceType {
  return value === "iMessage" || value === "SMS" || value === "RCS";
}
