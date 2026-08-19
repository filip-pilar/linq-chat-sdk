import { describe, expect, it, vi } from "vitest";

import {
  downloadLinqAttachment,
  LinqAttachmentDownloadError,
  type LinqInboundAttachmentReference,
} from "../src/inbound-media";

const reference: LinqInboundAttachmentReference = {
  attachmentId: "006a4826-7700-45e3-8796-39a7e26137e6",
  filename: "memo.m4a",
  mimeType: "audio/x-m4a",
  sizeBytes: 4,
};

function attachmentDetails(
  override: Partial<{
    content_type: string;
    download_url: string;
    filename: string;
    id: string;
    size_bytes: number;
  }> = {},
) {
  return {
    id: reference.attachmentId,
    filename: reference.filename,
    content_type: reference.mimeType,
    size_bytes: reference.sizeBytes,
    status: "complete" as const,
    created_at: "2026-07-31T00:00:00Z",
    download_url: "https://cdn.linqapp.com/attachments/memo.m4a?signature=fresh",
    ...override,
  };
}

function lookup(details = attachmentDetails()) {
  return {
    retrieve: vi.fn().mockResolvedValue(details),
  };
}

function audioResponse(bytes: Uint8Array = new Uint8Array([1, 2, 3, 4]), init: ResponseInit = {}) {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": reference.mimeType,
    },
    ...init,
  });
}

async function expectFailure(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "LinqAttachmentDownloadError",
    code,
    message: `Linq attachment download failed: ${code}`,
  });
}

describe("bounded Linq inbound attachment download", () => {
  it("retrieves a fresh URL and returns the bounded response bytes", async () => {
    const attachments = lookup();
    const fetchImpl = vi.fn().mockResolvedValue(audioResponse());

    await expect(
      downloadLinqAttachment(attachments, reference, { fetch: fetchImpl }),
    ).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    expect(attachments.retrieve).toHaveBeenCalledWith(reference.attachmentId, {
      signal: expect.any(AbortSignal),
      timeout: 30_000,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cdn.linqapp.com/attachments/memo.m4a?signature=fresh",
      {
        redirect: "manual",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it.each([
    "http://cdn.linqapp.com/attachments/memo.m4a",
    "https://evil.example/attachments/memo.m4a",
    "https://cdn.linqapp.com:444/attachments/memo.m4a",
    "https://user:pass@cdn.linqapp.com/attachments/memo.m4a",
  ])("rejects an unsafe provider URL without fetching it", async (downloadUrl) => {
    const fetchImpl = vi.fn();

    await expectFailure(
      downloadLinqAttachment(lookup(attachmentDetails({ download_url: downloadUrl })), reference, {
        fetch: fetchImpl,
      }),
      "unsafe_download_url",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects redirects without following them", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/memo.m4a" },
      }),
    );

    await expectFailure(
      downloadLinqAttachment(lookup(), reference, { fetch: fetchImpl }),
      "redirect_rejected",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts equivalent provider audio content-type aliases", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: {
          "content-length": "4",
          "content-type": "audio/mp4",
        },
      }),
    );

    await expect(
      downloadLinqAttachment(lookup(), reference, { fetch: fetchImpl }),
    ).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("accepts a bounded provider response size that differs from stable metadata", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const fetchImpl = vi.fn().mockResolvedValue(audioResponse(bytes));

    await expect(
      downloadLinqAttachment(lookup(), reference, { fetch: fetchImpl }),
    ).resolves.toEqual(Buffer.from(bytes));
  });

  it.each([
    [{ id: "106a4826-7700-45e3-8796-39a7e26137e6" }, "metadata_mismatch"],
    [{ filename: "other.m4a" }, "metadata_mismatch"],
    [{ content_type: "audio/mpeg" }, "metadata_mismatch"],
    [{ size_bytes: 5 }, "metadata_mismatch"],
  ])("rejects refreshed metadata drift", async (override, code) => {
    await expectFailure(
      downloadLinqAttachment(lookup(attachmentDetails(override)), reference, {
        fetch: vi.fn(),
      }),
      code,
    );
  });

  it("rejects an oversized declaration before provider lookup", async () => {
    const attachments = lookup();

    await expectFailure(
      downloadLinqAttachment(attachments, reference, {
        fetch: vi.fn(),
        maximumBytes: 3,
      }),
      "invalid_size",
    );
    expect(attachments.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    [
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: {
          "content-length": "0",
          "content-type": reference.mimeType,
        },
      }),
      "response_size_mismatch",
    ],
    [
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: {
          "content-length": "not-a-number",
          "content-type": reference.mimeType,
        },
      }),
      "invalid_content_length",
    ],
    [
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: {
          "content-length": "4",
          "content-type": "audio/mpeg",
        },
      }),
      "response_type_mismatch",
    ],
  ])("rejects hostile response headers", async (response, code) => {
    await expectFailure(
      downloadLinqAttachment(lookup(), reference, {
        fetch: vi.fn().mockResolvedValue(response),
      }),
      code,
    );
  });

  it("rejects a body that is shorter than its response content length", async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: {
        "content-length": "5",
        "content-type": reference.mimeType,
      },
    });

    await expectFailure(
      downloadLinqAttachment(lookup(), reference, {
        fetch: vi.fn().mockResolvedValue(response),
      }),
      "truncated_response",
    );
  });

  it("stream-counts and cancels immediately above the configured maximum", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      headers: { "content-type": reference.mimeType },
    });

    await expectFailure(
      downloadLinqAttachment(lookup(), reference, {
        fetch: vi.fn().mockResolvedValue(response),
        maximumBytes: 4,
      }),
      "response_too_large",
    );
    expect(cancelled).toBe(true);
  });

  it("accepts a non-empty bounded body when no content length is present", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const response = new Response(bytes, {
      headers: { "content-type": reference.mimeType },
    });

    await expect(
      downloadLinqAttachment(lookup(), reference, {
        fetch: vi.fn().mockResolvedValue(response),
      }),
    ).resolves.toEqual(Buffer.from(bytes));
  });

  it("rejects an empty body when no content length is present", async () => {
    const response = new Response(new Uint8Array(), {
      headers: { "content-type": reference.mimeType },
    });

    await expectFailure(
      downloadLinqAttachment(lookup(), reference, {
        fetch: vi.fn().mockResolvedValue(response),
      }),
      "truncated_response",
    );
  });

  it("cancels a rejected response body during cleanup", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    await expectFailure(
      downloadLinqAttachment(lookup(), reference, {
        fetch: vi.fn().mockResolvedValue(
          new Response(body, {
            status: 500,
            headers: { "content-type": reference.mimeType },
          }),
        ),
      }),
      "download_rejected",
    );
    expect(cancelled).toBe(true);
  });

  it("aborts lookup at the bounded timeout", async () => {
    const retrieve = vi.fn(
      (_attachmentId: string, options?: { signal?: AbortSignal }): Promise<never> =>
        new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new DOMException("timed out", "AbortError"));
          });
        }),
    );

    await expectFailure(
      downloadLinqAttachment({ retrieve }, reference, {
        fetch: vi.fn(),
        timeoutMs: 5,
      }),
      "timeout",
    );
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("maps raw provider failures without leaking their contents", async () => {
    const retrieve = vi
      .fn()
      .mockRejectedValue(new Error(`sensitive provider response for ${reference.attachmentId}`));

    await expectFailure(
      downloadLinqAttachment({ retrieve }, reference, { fetch: vi.fn() }),
      "provider_failure",
    );
  });

  it("keeps thrown failures content-free", () => {
    const error = new LinqAttachmentDownloadError("download_rejected");

    expect(error.message).toBe("Linq attachment download failed: download_rejected");
    expect(error.message).not.toContain(reference.attachmentId);
    expect(error.message).not.toContain("cdn.linqapp.com");
    expect(error.message).not.toContain(reference.filename);
  });
});
