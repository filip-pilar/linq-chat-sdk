const LINQ_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isLinqUuid(value: unknown): value is string {
  return typeof value === "string" && LINQ_UUID_PATTERN.test(value);
}

export function isUsableLinqId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

/** A provider chat ID must remain unambiguous inside `linq:{chatId}`. */
export function isUsableLinqChatId(value: unknown): value is string {
  return isUsableLinqId(value) && value !== "pending" && !value.includes(":");
}

/** Clone and recursively freeze one JSON-compatible provider value. */
export function immutableJsonSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
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
