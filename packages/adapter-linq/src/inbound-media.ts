import type { LinqAPIV3 } from "@linqapp/sdk";

const LINQ_MEDIA_HOST = "cdn.linqapp.com";
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_OTHER_MEDIA_BYTES = 100 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LinqAttachmentDetails = LinqAPIV3.Attachments.AttachmentRetrieveResponse;

interface LinqAttachmentLookup {
  retrieve(
    attachmentId: string,
    options?: { signal?: AbortSignal; timeout?: number },
  ): PromiseLike<LinqAttachmentDetails>;
}

export interface LinqInboundAttachmentReference {
  readonly attachmentId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

interface LinqInboundMediaDependencies {
  readonly fetch?: typeof fetch;
  readonly maximumBytes?: number;
  readonly timeoutMs?: number;
}

export function createLinqAttachmentFetcher(
  attachments: LinqAttachmentLookup,
  reference: LinqInboundAttachmentReference,
): () => Promise<Buffer> {
  return () => downloadLinqAttachment(attachments, reference);
}

export async function downloadLinqAttachment(
  attachments: LinqAttachmentLookup,
  reference: LinqInboundAttachmentReference,
  dependencies: LinqInboundMediaDependencies = {},
): Promise<Buffer> {
  const maximumBytes = dependencies.maximumBytes ?? maximumBytesFor(reference.mimeType);
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  validatePositiveInteger(maximumBytes, "invalid_maximum");
  validatePositiveInteger(timeoutMs, "invalid_timeout");
  validateReference(reference, maximumBytes);

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const details = await attachments.retrieve(reference.attachmentId, {
      signal: controller.signal,
      timeout: timeoutMs,
    });
    validateFreshDetails(details, reference, maximumBytes);
    const url = requireSafeLinqMediaUrl(details.download_url);
    const response = await (dependencies.fetch ?? fetch)(url, {
      redirect: "manual",
      signal: controller.signal,
    });
    try {
      validateDownloadResponse(response, reference, maximumBytes);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }

    return await readBoundedBody(response, reference.sizeBytes, maximumBytes, controller);
  } catch (error) {
    if (timedOut) {
      throw new LinqAttachmentDownloadError("timeout");
    }
    if (error instanceof LinqAttachmentDownloadError) {
      throw error;
    }
    throw new LinqAttachmentDownloadError("provider_failure");
  } finally {
    clearTimeout(timeout);
  }
}

function validateReference(reference: LinqInboundAttachmentReference, maximumBytes: number): void {
  if (!UUID_PATTERN.test(reference.attachmentId)) {
    throw new LinqAttachmentDownloadError("invalid_reference");
  }
  if (!isSafeFilename(reference.filename)) {
    throw new LinqAttachmentDownloadError("invalid_filename");
  }
  if (!isMediaType(reference.mimeType)) {
    throw new LinqAttachmentDownloadError("invalid_media_type");
  }
  if (
    !Number.isSafeInteger(reference.sizeBytes) ||
    reference.sizeBytes <= 0 ||
    reference.sizeBytes > maximumBytes
  ) {
    throw new LinqAttachmentDownloadError("invalid_size");
  }
}

function validateFreshDetails(
  details: LinqAttachmentDetails,
  reference: LinqInboundAttachmentReference,
  maximumBytes: number,
): void {
  if (
    details.id !== reference.attachmentId ||
    details.filename !== reference.filename ||
    normalizeMediaType(details.content_type) !== normalizeMediaType(reference.mimeType) ||
    details.size_bytes !== reference.sizeBytes
  ) {
    throw new LinqAttachmentDownloadError("metadata_mismatch");
  }
  if (
    !Number.isSafeInteger(details.size_bytes) ||
    details.size_bytes <= 0 ||
    details.size_bytes > maximumBytes
  ) {
    throw new LinqAttachmentDownloadError("invalid_size");
  }
}

function requireSafeLinqMediaUrl(value: string | undefined): string {
  if (!value) {
    throw new LinqAttachmentDownloadError("missing_download_url");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LinqAttachmentDownloadError("unsafe_download_url");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== LINQ_MEDIA_HOST ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    throw new LinqAttachmentDownloadError("unsafe_download_url");
  }
  return url.toString();
}

function validateDownloadResponse(
  response: Response,
  reference: LinqInboundAttachmentReference,
  maximumBytes: number,
): void {
  if (response.status >= 300 && response.status < 400) {
    throw new LinqAttachmentDownloadError("redirect_rejected");
  }
  if (!response.ok) {
    throw new LinqAttachmentDownloadError("download_rejected");
  }
  if (response.url) {
    requireSafeLinqMediaUrl(response.url);
  }

  const contentType = response.headers.get("content-type");
  if (!contentType || normalizeMediaType(contentType) !== normalizeMediaType(reference.mimeType)) {
    throw new LinqAttachmentDownloadError("response_type_mismatch");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new LinqAttachmentDownloadError("invalid_content_length");
    }
    const parsedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength !== reference.sizeBytes ||
      parsedLength > maximumBytes
    ) {
      throw new LinqAttachmentDownloadError("response_size_mismatch");
    }
  }
}

async function readBoundedBody(
  response: Response,
  expectedBytes: number,
  maximumBytes: number,
  controller: AbortController,
): Promise<Buffer> {
  if (!response.body) {
    throw new LinqAttachmentDownloadError("missing_body");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > expectedBytes || byteLength > maximumBytes) {
        controller.abort();
        await reader.cancel();
        throw new LinqAttachmentDownloadError("response_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (byteLength !== expectedBytes) {
    throw new LinqAttachmentDownloadError("truncated_response");
  }
  return Buffer.concat(chunks, byteLength);
}

function maximumBytesFor(mimeType: string): number {
  return normalizeMediaType(mimeType).startsWith("audio/")
    ? MAX_AUDIO_BYTES
    : MAX_OTHER_MEDIA_BYTES;
}

function normalizeMediaType(value: string): string {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (["audio/m4a", "audio/mp4", "audio/x-m4a"].includes(mediaType)) {
    return "audio/mp4";
  }
  if (["audio/mp3", "audio/mpeg"].includes(mediaType)) {
    return "audio/mpeg";
  }
  if (["audio/wav", "audio/x-wav"].includes(mediaType)) {
    return "audio/wav";
  }
  if (mediaType === "image/jpg") {
    return "image/jpeg";
  }
  return mediaType;
}

function isMediaType(value: string): boolean {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(
    normalizeMediaType(value),
  );
}

function isSafeFilename(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value === value.trim() &&
    !value.includes("/") &&
    !value.includes("\\") &&
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
    })
  );
}

function validatePositiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LinqAttachmentDownloadError(code);
  }
}

export class LinqAttachmentDownloadError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Linq attachment download failed: ${code}`);
    this.name = "LinqAttachmentDownloadError";
    this.code = code;
  }
}
