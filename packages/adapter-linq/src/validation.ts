import { linqValidationError } from "./errors.js";
import { isLinqUuid, isRecord } from "./guards.js";
import type { AdapterPostableMessage } from "chat";

export function normalizeLinqHandle(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() !== value) {
    throw linqValidationError(message);
  }

  const isE164 = /^\+[1-9]\d{1,14}$/u.test(value);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  if (!isE164 && !isEmail) {
    throw linqValidationError(message);
  }

  return value;
}

export function normalizePublicHttpsUrl(value: unknown, message: string): string {
  if (typeof value !== "string" && !(value instanceof URL)) {
    throw linqValidationError(message);
  }

  const url = typeof value === "string" ? value : value.href;
  if (url.length === 0 || (typeof value === "string" && value.trim() !== value)) {
    throw linqValidationError(message);
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && parsed.hostname.length > 0) {
      return url;
    }
  } catch {
    // Fall through to the stable adapter validation error.
  }

  throw linqValidationError(message);
}

export function validateLinqMessageId(messageId: string): void {
  if (!isLinqUuid(messageId)) {
    throw linqValidationError("Linq message IDs must be UUIDs.");
  }
}

export function validateLinqPartIndex(partIndex: number): void {
  if (!Number.isInteger(partIndex) || partIndex < 0) {
    throw linqValidationError("Linq message part indexes must be non-negative integers.");
  }
}

export function validateLinqPostableContent(content: AdapterPostableMessage): void {
  if (typeof content !== "string" && !isRecord(content)) {
    throw linqValidationError("Linq replies require valid Chat SDK message content.");
  }
}
