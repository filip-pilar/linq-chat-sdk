import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";

import { isRecord } from "./guards.js";

const ADAPTER_NAME = "linq";

type ErrorContext = {
  action: string;
  resourceId?: string;
  resourceType: string;
};

export async function runLinqOperation<T>(
  context: ErrorContext,
  callback: () => Promise<T>,
): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    throw translateLinqError(error, context);
  }
}

type LinqErrorMetadata = {
  providerCode?: string | number;
  retryAfter?: number;
  traceId?: string;
};

export function translateLinqError(error: unknown, context: ErrorContext): Error {
  if (error instanceof AdapterError) {
    return error;
  }

  const status = readStatus(error);
  const metadata = readMetadata(error);
  const message = readProviderMessage(error);
  let translated: AdapterError;

  switch (status) {
    case 400:
    case 422:
      translated = new ValidationError(ADAPTER_NAME, message ?? "Linq rejected the request");
      break;
    case 401:
      translated = new AuthenticationError(ADAPTER_NAME, message);
      break;
    case 403:
      translated = new PermissionError(ADAPTER_NAME, context.action);
      break;
    case 404:
      translated = new ResourceNotFoundError(
        ADAPTER_NAME,
        context.resourceType,
        context.resourceId,
      );
      break;
    case 429:
      translated = new AdapterRateLimitError(ADAPTER_NAME, metadata.retryAfter);
      break;
    default:
      if (status === undefined && error instanceof Error) {
        translated = new NetworkError(ADAPTER_NAME, message, error);
      } else {
        translated = new AdapterError(message ?? "Linq request failed", ADAPTER_NAME);
      }
  }

  preserveLinqError(translated, error, metadata);

  return translated;
}

/** A successful HTTP response whose JSON cannot satisfy the adapter's public contract. */
export function invalidLinqProviderResponse(action: string, detail: string): AdapterError {
  const cause = new TypeError(`Invalid Linq ${action} response: ${detail}`);
  const error = new AdapterError(
    `Linq returned an invalid response while attempting to ${action}`,
    ADAPTER_NAME,
  );

  Object.defineProperty(error, "cause", {
    configurable: true,
    value: cause,
  });

  return error;
}

export function linqValidationError(message: string): ValidationError {
  return new ValidationError(ADAPTER_NAME, message);
}

function preserveLinqError(
  translated: AdapterError,
  originalError: unknown,
  metadata: LinqErrorMetadata,
): void {
  Object.defineProperty(translated, "cause", {
    configurable: true,
    value: originalError,
  });

  if (metadata.providerCode !== undefined) {
    Object.defineProperty(translated, "providerCode", {
      configurable: true,
      enumerable: true,
      value: metadata.providerCode,
    });
  }

  if (metadata.traceId !== undefined) {
    Object.defineProperty(translated, "traceId", {
      configurable: true,
      enumerable: true,
      value: metadata.traceId,
    });
  }
}

function readStatus(error: unknown): number | undefined {
  return isRecord(error) && typeof error.status === "number" ? error.status : undefined;
}

function readMetadata(error: unknown): LinqErrorMetadata {
  if (!isRecord(error)) {
    return {};
  }

  const responseBody = isRecord(error.error) ? error.error : undefined;
  const detail = responseBody && isRecord(responseBody.error) ? responseBody.error : responseBody;
  const headers = readHeaders(error.headers);

  return {
    providerCode:
      detail && (typeof detail.code === "number" || typeof detail.code === "string")
        ? detail.code
        : undefined,
    retryAfter: readRetryAfter(detail?.retry_after) ?? readRetryAfter(headers?.get("retry-after")),
    traceId:
      (responseBody && typeof responseBody.trace_id === "string" && responseBody.trace_id) ||
      headers?.get("x-trace-id") ||
      undefined,
  };
}

function readHeaders(headers: unknown): { get(name: string): string | null } | undefined {
  if (!isRecord(headers) || typeof headers.get !== "function") {
    return undefined;
  }

  const get = headers.get;

  return {
    get: (name) => {
      const value: unknown = get.call(headers, name);

      return typeof value === "string" ? value : null;
    },
  };
}

function readProviderMessage(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return error instanceof Error ? error.message : undefined;
  }

  const responseBody = isRecord(error.error) ? error.error : undefined;
  const detail = responseBody && isRecord(responseBody.error) ? responseBody.error : responseBody;

  if (detail && typeof detail.message === "string") {
    return detail.message;
  }

  return error instanceof Error ? error.message : undefined;
}

function readRetryAfter(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }

  const date = Date.parse(value);

  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1_000));
}
