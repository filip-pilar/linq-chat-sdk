import { ValidationError } from "@chat-adapter/shared";
import { LinqAPIV3 } from "@linqapp/sdk";
import type { AdapterPostableMessage, Attachment, FileUpload } from "chat";

import { isRecord } from "./guards.js";

const ADAPTER_NAME = "linq";
const MAX_FILENAME_CHARACTERS = 255;
const MAX_MESSAGE_PARTS = 100;
const MAX_PUBLIC_URL_PARTS = 40;
const MAX_TEXT_CHARACTERS = 10_000;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MIN_UPLOAD_BYTES = 1;

// Linq downloads `url`-based media on send and caps those at 10MB. Anything
// larger (or not reachable over public HTTPS) has to go through the pre-upload
// flow, which allows up to 100MB.
const URL_DOWNLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

type LinqOutboundPart =
  | { type: "text"; value: string }
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
  media: PlannedMediaPart[];
  text?: string;
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
  text: string,
  cardImageUrls: string[],
): LinqOutboundMessagePlan {
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
    text: text || undefined,
  };
}

export async function prepareLinqOutboundParts(
  apiClient: LinqAPIV3,
  plan: LinqOutboundMessagePlan,
  onAttachmentCreated: (attachmentId: string) => void,
): Promise<LinqOutboundPart[]> {
  const parts: LinqOutboundPart[] = [];

  if (plan.text) {
    parts.push({ type: "text", value: plan.text });
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

  if (
    typeof attachment.url === "string" &&
    attachment.url.startsWith("https://") &&
    !exceedsUrlDownloadLimit(attachment.size)
  ) {
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
  onAttachmentCreated(created.attachment_id);

  const upload = await fetch(created.upload_url, {
    method: created.http_method,
    headers: created.required_headers,
    body: bytes,
  });

  if (!upload.ok) {
    throw new Error(
      `Failed to upload Linq attachment ${filename}: ${upload.status} ${upload.statusText}`,
    );
  }

  return created.attachment_id;
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

  if (attachment.url) {
    let response: Response;

    try {
      response = await fetch(attachment.url);
    } catch (error) {
      throw new Error(`Failed to download Linq attachment ${attachment.name ?? attachment.url}`, {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new Error(
        `Failed to download Linq attachment ${attachment.name ?? attachment.url}: ${response.status}`,
      );
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  throw validationError(
    `Outbound attachment ${attachment.name ?? "(unnamed)"} has no data, fetchData, or url to send.`,
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

  if (
    typeof attachment.fetchData === "function" ||
    (typeof attachment.url === "string" && attachment.url.length > 0)
  ) {
    return;
  }

  throw validationError(
    `Outbound attachment ${attachment.name ?? "(unnamed)"} has no data, fetchData, or url to send.`,
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
