import { invalidLinqProviderResponse } from "./errors.js";
import { isRecord, isUsableLinqChatId, isUsableLinqId } from "./guards.js";

export function requireProviderRecord(
  value: unknown,
  action: string,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw invalidLinqProviderResponse(action, `${field} must be an object`);
  }

  return value;
}

export function requireProviderId(value: unknown, action: string, field: string): string {
  if (!isUsableLinqId(value)) {
    throw invalidLinqProviderResponse(action, `${field} must be a non-empty string`);
  }

  return value;
}

export function requireProviderChatId(value: unknown, action: string, field: string): string {
  if (!isUsableLinqChatId(value)) {
    throw invalidLinqProviderResponse(action, `${field} cannot form a canonical Linq thread ID`);
  }

  return value;
}

export function requireMatchingProviderId(
  value: unknown,
  expected: string,
  action: string,
  field: string,
): string {
  const actual = requireProviderId(value, action, field);
  if (actual !== expected) {
    throw invalidLinqProviderResponse(action, `${field} does not match the requested resource`);
  }

  return actual;
}
