import { isIP } from "node:net";
import { ValidationError } from "@chat-adapter/shared";
import { LinqAPIV3 } from "@linqapp/sdk";
import type { AdapterPostableMessage, Attachment, FileUpload } from "chat";

import { invalidLinqProviderResponse } from "./errors.js";
import { isRecord } from "./guards.js";
import type { CompiledLinqMessageText, LinqCompiledDecoration } from "./message-compiler.js";

const ADAPTER_NAME = "linq";
const MAX_FILENAME_CHARACTERS = 255;
const MAX_MESSAGE_PARTS = 100;
const MAX_PUBLIC_URL_PARTS = 40;
const MAX_TEXT_CHARACTERS = 10_000;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MIN_UPLOAD_BYTES = 1;
const UPLOAD_TIMEOUT_MS = 30_000;

// Linq downloads `url`-based media on send and caps those at 10MB. Larger media
// has to use caller-supplied bytes through the pre-upload flow, which allows up
// to 100MB. The adapter never fetches arbitrary outbound source URLs itself.
const URL_DOWNLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

type LinqOutboundPart =
  | { type: "link"; value: string }
  | { type: "text"; value: string; text_decorations?: LinqCompiledDecoration[] }
  | { type: "media"; url: string }
  | { type: "media"; attachment_id: string };

type BinaryData = Buffer | Blob | ArrayBuffer | Uint8Array;

// Bytes guaranteed to be backed by a plain ArrayBuffer (not SharedArrayBuffer),
// which is what `fetch` and `Blob` accept as a body.
type UploadBytes = Uint8Array<ArrayBuffer>;

type PlannedUpload = {
  contentType: string;
  filename: string;
  source: { attachment: Attachment; kind: "attachment" } | { file: FileUpload; kind: "file" };
  type: "upload";
};

type PlannedMediaPart = { type: "url"; url: string } | PlannedUpload;

type LinqOutboundMessagePlan = {
  cardImageUrls: string[];
  link?: string;
  media: PlannedMediaPart[];
  text?: CompiledLinqMessageText;
};

// A subset of Linq's supported types, keyed by file extension. Linq validates
// the real file content on its end; this only needs to be good enough to label
// the pre-upload request. Callers can always pass an explicit mimeType.
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  "3gp": "video/3gpp",
  m4a: "audio/x-m4a",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  wav: "audio/x-wav",
  aiff: "audio/x-aiff",
  caf: "audio/x-caf",
  amr: "audio/amr",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  rtf: "text/rtf",
  vcf: "text/vcard",
  ics: "text/calendar",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function planLinqOutboundMessage(
  message: AdapterPostableMessage,
  compiledText: CompiledLinqMessageText,
  cardImageUrls: string[],
  richLink?: string,
): LinqOutboundMessagePlan {
  const { text } = compiledText;
  if (text && characterCount(text) > MAX_TEXT_CHARACTERS) {
    throw validationError(`Linq message text cannot exceed ${MAX_TEXT_CHARACTERS} characters.`);
  }

  for (const url of cardImageUrls) {
    assertValidHttpsUrl(url);
  }

  const { attachments, files } = extractOutboundMedia(message);
  const media = [
    ...attachments.map(planAttachment),
    ...files.map(planFile),
  ] satisfies PlannedMediaPart[];

  if (richLink !== undefined) {
    if (text || cardImageUrls.length > 0 || media.length > 0) {
      throw validationError(
        "Linq rich links must be the only message content and cannot include text, cards, files, or attachments.",
      );
    }

    return { cardImageUrls: [], link: richLink, media: [] };
  }

  const totalParts = (text ? 1 : 0) + cardImageUrls.length + media.length;

  if (totalParts === 0) {
    throw validationError("Linq message must include text or media.");
  }

  if (totalParts > MAX_MESSAGE_PARTS) {
    throw validationError(`Linq messages cannot exceed ${MAX_MESSAGE_PARTS} total parts.`);
  }

  const publicUrlParts = cardImageUrls.length + media.filter((part) => part.type === "url").length;

  if (publicUrlParts > MAX_PUBLIC_URL_PARTS) {
    throw validationError(
      `Linq messages cannot exceed ${MAX_PUBLIC_URL_PARTS} public-URL media parts.`,
    );
  }

  return {
    cardImageUrls: [...cardImageUrls],
    media,
    text: text ? compiledText : undefined,
  };
}

export async function prepareLinqOutboundParts(
  apiClient: LinqAPIV3,
  plan: LinqOutboundMessagePlan,
  onAttachmentCreated: (attachmentId: string) => void,
): Promise<LinqOutboundPart[]> {
  const parts: LinqOutboundPart[] = [];

  if (plan.link) {
    return [{ type: "link", value: plan.link }];
  }

  if (plan.text) {
    parts.push({
      type: "text",
      value: plan.text.text,
      ...(plan.text.decorations.length > 0
        ? { text_decorations: plan.text.decorations.map((decoration) => ({ ...decoration })) }
        : {}),
    });
  }

  for (const url of plan.cardImageUrls) {
    parts.push({ type: "media", url });
  }

  for (const media of plan.media) {
    if (media.type === "url") {
      parts.push({ type: "media", url: media.url });
      continue;
    }

    const bytes = await resolveUploadBytes(media.source);
    validateUploadSize(bytes.byteLength);
    const attachmentId = await uploadBytes(
      apiClient,
      bytes,
      media.filename,
      media.contentType,
      onAttachmentCreated,
    );

    parts.push({ type: "media", attachment_id: attachmentId });
  }

  return parts;
}

// Pull the outbound attachments/files off a postable. Only object-form postables
// (markdown/raw/ast) carry them; strings and cards contribute nothing here.
function extractOutboundMedia(message: AdapterPostableMessage): {
  attachments: Attachment[];
  files: FileUpload[];
} {
  if (typeof message === "string" || !isRecord(message)) {
    return { attachments: [], files: [] };
  }

  const attachments = Array.isArray(message.attachments)
    ? (message.attachments as Attachment[])
    : [];
  const files = Array.isArray(message.files) ? (message.files as FileUpload[]) : [];

  return { attachments, files };
}

function planAttachment(attachment: Attachment): PlannedMediaPart {
  if (!isRecord(attachment)) {
    throw validationError("Linq attachments must be attachment objects.");
  }

  if (typeof attachment.url === "string" && !exceedsUrlDownloadLimit(attachment.size)) {
    assertValidHttpsUrl(attachment.url);

    return { type: "url", url: attachment.url };
  }

  const filename = attachment.name ?? defaultFilename(attachment.mimeType);
  validateFilename(filename);
  validateDeclaredUploadSize(attachment.size);
  validateAttachmentSource(attachment);

  return {
    contentType: resolveContentType(attachment.mimeType, filename),
    filename,
    source: { attachment, kind: "attachment" },
    type: "upload",
  };
}

function planFile(file: FileUpload): PlannedUpload {
  if (!isRecord(file)) {
    throw validationError("Linq files must be file upload objects.");
  }

  validateFilename(file.filename);
  validateBinaryData(file.data);
  validateUploadSize(binarySize(file.data));

  return {
    contentType: resolveContentType(file.mimeType, file.filename),
    filename: file.filename,
    source: { file, kind: "file" },
    type: "upload",
  };
}

async function uploadBytes(
  apiClient: LinqAPIV3,
  bytes: UploadBytes,
  filename: string,
  contentType: string,
  onAttachmentCreated: (attachmentId: string) => void,
): Promise<string> {
  const created = await apiClient.attachments.create(
    {
      filename,
      content_type: contentType as LinqAPIV3.SupportedContentType,
      size_bytes: bytes.byteLength,
    },
    { maxRetries: 0 },
  );
  if (!isRecord(created) || Array.isArray(created)) {
    throw invalidLinqProviderResponse("create attachment", "response must be an object");
  }
  const attachmentId = requireUploadResponseString(created.attachment_id, "attachment_id");
  onAttachmentCreated(attachmentId);
  const uploadUrl = requireUploadResponseString(created.upload_url, "upload_url");
  assertValidUploadUrl(uploadUrl);
  if (created.http_method !== "PUT") {
    throw invalidLinqProviderResponse("create attachment", "http_method must be PUT");
  }
  if (!isRecord(created.required_headers) || Array.isArray(created.required_headers)) {
    throw invalidLinqProviderResponse("create attachment", "required_headers must be an object");
  }
  const requiredHeaders = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(created.required_headers)) {
    if (typeof value !== "string") {
      throw invalidLinqProviderResponse(
        "create attachment",
        "required_headers values must be strings",
      );
    }
    requiredHeaders[name] = value;
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPLOAD_TIMEOUT_MS);
  let upload: Response;

  try {
    upload = await fetch(uploadUrl, {
      method: "PUT",
      headers: requiredHeaders,
      body: bytes,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `Linq attachment upload timed out after ${UPLOAD_TIMEOUT_MS}ms for ${filename}`,
        { cause: error },
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!upload.ok) {
    throw new Error(
      `Failed to upload Linq attachment ${filename}: ${upload.status} ${upload.statusText}`,
    );
  }

  return attachmentId;
}

function requireUploadResponseString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw invalidLinqProviderResponse("create attachment", `${field} must be a non-empty string`);
  }

  return value;
}

async function resolveUploadBytes(source: PlannedUpload["source"]): Promise<UploadBytes> {
  if (source.kind === "file") {
    return toBytes(source.file.data);
  }

  const { attachment } = source;

  if (attachment.data != null) {
    return toBytes(attachment.data);
  }

  if (typeof attachment.fetchData === "function") {
    return toBytes(await attachment.fetchData());
  }

  throw validationError(
    `Outbound attachment ${attachment.name ?? "(unnamed)"} requires data or fetchData for pre-upload.`,
  );
}

// Copy into a fresh ArrayBuffer-backed view. The copy also detaches us from any
// SharedArrayBuffer backing, which `fetch` bodies reject.
async function toBytes(data: BinaryData): Promise<UploadBytes> {
  validateBinaryData(data);

  if (data instanceof Uint8Array) {
    return new Uint8Array(data);
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return new Uint8Array(await data.arrayBuffer());
}

function validateAttachmentSource(attachment: Attachment): void {
  if (attachment.data != null) {
    validateBinaryData(attachment.data);
    validateUploadSize(binarySize(attachment.data));
    return;
  }

  if (typeof attachment.fetchData === "function") {
    return;
  }

  throw validationError(
    `Outbound attachment ${attachment.name ?? "(unnamed)"} requires data or fetchData for pre-upload.`,
  );
}

function validateBinaryData(data: unknown): asserts data is BinaryData {
  if (
    data instanceof Uint8Array ||
    data instanceof ArrayBuffer ||
    (typeof Blob !== "undefined" && data instanceof Blob)
  ) {
    return;
  }

  throw validationError("Unsupported attachment data type; expected Buffer, Blob, or ArrayBuffer.");
}

function binarySize(data: BinaryData): number {
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.size;
  }

  return "byteLength" in data ? data.byteLength : 0;
}

function validateFilename(filename: unknown): asserts filename is string {
  if (typeof filename !== "string") {
    throw validationError("Linq upload filenames must be strings.");
  }

  const length = characterCount(filename);

  if (length < 1 || length > MAX_FILENAME_CHARACTERS) {
    throw validationError(
      `Linq upload filenames must contain 1-${MAX_FILENAME_CHARACTERS} characters.`,
    );
  }
}

function validateDeclaredUploadSize(size: number | undefined): void {
  if (size === undefined) {
    return;
  }

  validateUploadSize(size);
}

function validateUploadSize(size: number): void {
  if (!Number.isInteger(size) || size < MIN_UPLOAD_BYTES || size > MAX_UPLOAD_BYTES) {
    throw validationError(
      `Linq uploads must contain ${MIN_UPLOAD_BYTES}-${MAX_UPLOAD_BYTES} bytes.`,
    );
  }
}

function assertValidHttpsUrl(url: string): void {
  try {
    const parsed = new URL(url);

    if (parsed.protocol === "https:" && parsed.hostname) {
      return;
    }
  } catch {
    // Fall through to the standard validation error.
  }

  throw validationError("Linq media URL parts must be valid public HTTPS URLs.");
}

function assertValidUploadUrl(url: string): void {
  try {
    const parsed = new URL(url);

    if (
      parsed.protocol === "https:" &&
      parsed.hostname &&
      parsed.username === "" &&
      parsed.password === "" &&
      !isLocalUploadHostname(parsed.hostname)
    ) {
      return;
    }
  } catch {
    // Fall through to the standard validation error.
  }

  throw validationError("Linq attachment upload URLs must be credential-free public HTTPS URLs.");
}

function isLocalUploadHostname(hostname: string): boolean {
  const normalized = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const version = isIP(normalized);
  if (version === 4) {
    return isNonPublicIPv4(normalized);
  }

  if (version === 6) {
    const groups = parseIPv6Groups(normalized);
    if (!groups) return true;

    const first = groups[0] ?? 0;
    const isUnspecified = groups.every((group) => group === 0);
    const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
    const isUniqueLocal = (first & 0xfe00) === 0xfc00;
    const isLinkLocal = (first & 0xffc0) === 0xfe80;
    const isSiteLocal = (first & 0xffc0) === 0xfec0;
    const isMulticast = (first & 0xff00) === 0xff00;
    const isIPv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
    const isIPv4Compatible = groups.slice(0, 6).every((group) => group === 0);

    if (isIPv4Mapped || isIPv4Compatible) {
      const high = groups[6] ?? 0;
      const low = groups[7] ?? 0;
      const ipv4 = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
      return isNonPublicIPv4(ipv4);
    }

    return (
      isUnspecified || isLoopback || isUniqueLocal || isLinkLocal || isSiteLocal || isMulticast
    );
  }

  return false;
}

function isNonPublicIPv4(address: string): boolean {
  const [first = 0, second = 0] = address.split(".").map(Number);

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function parseIPv6Groups(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }

  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return null;
  }

  return groups.map((group) => Number.parseInt(group, 16));
}

function exceedsUrlDownloadLimit(size: number | undefined): boolean {
  return typeof size === "number" && size > URL_DOWNLOAD_LIMIT_BYTES;
}

function resolveContentType(mimeType: string | undefined, filename: string): string {
  if (mimeType && mimeType.trim()) {
    return normalizeMimeType(mimeType.trim());
  }

  const extension = filename.split(".").pop()?.toLowerCase();
  const inferred = extension ? EXTENSION_CONTENT_TYPES[extension] : undefined;

  if (inferred) {
    return inferred;
  }

  throw validationError(
    `Cannot determine content type for attachment "${filename}"; set mimeType on the attachment.`,
  );
}

function normalizeMimeType(mimeType: string): string {
  const lower = mimeType.toLowerCase();

  if (lower === "image/jpg") {
    return "image/jpeg";
  }

  return lower;
}

function defaultFilename(mimeType: string | undefined): string {
  const extension = mimeType ? extensionForMimeType(mimeType) : undefined;

  return extension ? `attachment.${extension}` : "attachment";
}

function extensionForMimeType(mimeType: string): string | undefined {
  const normalized = normalizeMimeType(mimeType);

  for (const [extension, candidate] of Object.entries(EXTENSION_CONTENT_TYPES)) {
    if (candidate === normalized) {
      return extension;
    }
  }

  return undefined;
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function validationError(message: string): ValidationError {
  return new ValidationError(ADAPTER_NAME, message);
}
