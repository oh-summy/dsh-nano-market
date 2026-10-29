// @oh-summy/connect-lark — Image handling (ARCHITECTURE §3.1).
//
// Image flow: download -> attachment admission -> vision gate -> honest fallback.
// The gate must do ALL THREE things (like dsh-acp assertImageRoute):
//   1) await resolveModelInfo()  — it returns a Promise, must await
//   2) guard undefined inputModalities — cannot call .includes() on undefined
//   3) treat unknown as unsupported — do NOT rely on the model throwing
//
// DO NOT rely on the model throwing: dsh-llm substitutes a text placeholder
// instead (dsh-llm/lib/index.js:559). Gate BEFORE queueing.

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Maximum image bytes to admit (20 MiB default, same as dsh-acp). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Maximum number of inbound images to process per message. */
export const MAX_IMAGES_PER_MESSAGE = 4;

/** Download an inbound image with bounded heap usage. */
export async function downloadImageBounded(
  channel: {
    downloadResourceToFile?: (messageId: string, fileKey: string, type: "image" | "file", destPath: string) => Promise<unknown>;
    downloadResource: (messageId: string, fileKey: string, type: "image" | "file") => Promise<Buffer>;
    rawClient?: any;
  },
  messageId: string,
  fileKey: string,
): Promise<Buffer> {
  // H7: pre-check Content-Length so a huge file is rejected before it is
  // written to disk. Best-effort: if the header is absent we still download.
  if (channel.rawClient) {
    try {
      const response = await channel.rawClient.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: "image" },
        responseType: "stream",
      });
      const contentLength = response.headers?.["content-length"];
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (!Number.isNaN(size) && size > MAX_IMAGE_BYTES) {
          response.data?.destroy?.();
          throw new Error("image exceeds " + MAX_IMAGE_BYTES + " bytes");
        }
      }
      response.data?.destroy?.();
    } catch (e) {
      if (/exceeds/.test((e as Error).message)) throw e;
      // Header check failed; fall through to the actual download.
    }
  }
  if (channel.downloadResourceToFile) {
    const dir = await mkdtemp(join(tmpdir(), "connect-lark-"));
    const destPath = join(dir, "image.bin");
    try {
      await channel.downloadResourceToFile(messageId, fileKey, "image", destPath);
      const info = await stat(destPath);
      if (info.size > MAX_IMAGE_BYTES) throw new Error("image exceeds " + MAX_IMAGE_BYTES + " bytes");
      return await readFile(destPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const buffer = await channel.downloadResource(messageId, fileKey, "image");
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("image exceeds " + MAX_IMAGE_BYTES + " bytes");
  return buffer;
}

export interface ImageAdmitResult {
  /** True when the current route supports image input. */
  supported: boolean;
  /** Attachment refs when supported; empty array when not. */
  refs: readonly unknown[];
  /** Human-readable reason when unsupported. */
  reason?: string;
}

/**
 * Admit an image for the current model route.
 *
 * @param ctx - DSH context (needs llm + attachments services).
 * @param provider - exact provider id.
 * @param model - exact model id.
 * @param buffer - raw image bytes.
 * @param signal - cancellation signal.
 * @returns admission result; never throws for "unsupported" (returns supported:false).
 */
export async function admitImage(
  ctx: {
    llm: { resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<{ inputModalities?: readonly string[] }> };
    attachments: { saveImages: (inputs: readonly unknown[]) => Promise<readonly unknown[]> };
  },
  provider: string,
  model: string,
  buffer: Buffer,
  signal?: AbortSignal,
): Promise<ImageAdmitResult> {
  // Size check before any model or attachment work.
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return { supported: false, refs: [], reason: "image exceeds " + MAX_IMAGE_BYTES + " bytes" };
  }

  // With an explicit model route, require declared image input. With the DSH
  // default route the host owns model selection, so persist the image and let
  // the host apply its own capability checks.
  if (provider && model) {
    let info;
    try {
      info = await ctx.llm.resolveModelInfo(provider, model, signal);
    } catch (e) {
      return { supported: false, refs: [], reason: "cannot verify model for image input: " + (e as Error).message };
    }
    signal?.throwIfAborted();
    if (info === undefined || info === null) {
      return { supported: false, refs: [], reason: "model info is undefined" };
    }
    if (info.inputModalities === undefined || !info.inputModalities.includes("image")) {
      return { supported: false, refs: [], reason: "model does not declare image input" };
    }
  }

  // Admission: saveImages returns refs in order.
  // Detect actual image type from magic bytes (Feishu sends JPEG, not PNG).
  const mediaType = detectImageMediaType(buffer);
  try {
    const refs = await ctx.attachments.saveImages([{ data: buffer, mediaType }]);
    return { supported: true, refs };
  } catch (e) {
    return { supported: false, refs: [], reason: "saveImages failed: " + (e as Error).message };
  }
}

/**
 * Detect image media type from magic bytes.
 * Feishu/Lark inbound images are typically JPEG; we must not hardcode PNG
 * because the host validates that declared mediaType matches actual bytes.
 */
export function detectImageMediaType(buffer: Buffer): string {
  // JPEG: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  // WebP: RIFF....WEBP
  if (buffer.length >= 12 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  // GIF: GIF87a / GIF89a
  if (buffer.length >= 6 && (buffer.slice(0, 3).toString("ascii") === "GIF")) return "image/gif";
  // Default to PNG (most common fallback)
  return "image/png";
}

/** Honest fallback when image input is unsupported (ARCHITECTURE §3.1). */
export const IMAGE_UNSUPPORTED_REPLY = "暂时不支持查看图片（当前模型路由未声明图像输入）。";

/**
 * Build the content array for a user message, adding image blocks when admitted.
 * Returns text-only content when unsupported.
 */
export function buildImageContent(
  text: string,
  admit: ImageAdmitResult,
): Array<{ type: string; text?: string; attachment?: unknown }> {
  if (!admit.supported || admit.refs.length === 0) {
    return [{ type: "text", text }];
  }
  const content: Array<{ type: string; text?: string; attachment?: unknown }> = [{ type: "text", text }];
  for (const ref of admit.refs) {
    content.push({ type: "image", attachment: ref });
  }
  return content;
}

/**
 * Internal helper: inbound image download (SSRF-guarded).
 * Not used by the production path (which uses downloadImageBounded).
 *
 * Only accepts https URLs from known Feishu CDN hosts. Never follows redirects
 * to arbitrary hosts (privacy + SSRF risk, ARCHITECTURE §3.1).
 */
export const FEISHU_CDN_HOSTS = new Set([
  "lf3-cdn-tos.bytecdntp.com",
  "lf6-cdn-tos.bytecdntp.com",
]);

export async function downloadInboundImage(
  url: string,
  maxBytes: number = MAX_IMAGE_BYTES,
): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid image URL: " + url);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("image URL must be https: got " + parsed.protocol);
  }
  if (!FEISHU_CDN_HOSTS.has(parsed.hostname)) {
    throw new Error("image URL host not in allowed CDN set: " + parsed.hostname);
  }
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error("image download HTTP " + res.status);
  // Check Content-Length before buffering (memory DoS guard).
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new Error("image exceeds " + maxBytes + " bytes (Content-Length " + len + ")");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error("image exceeds " + maxBytes + " bytes");
  return buf;
}
