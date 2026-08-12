/**
 * Image transfer strategy.
 *
 * Sending image_url parts to a TEXT-ONLY main model (e.g. deepseek-v4-flash)
 * fails with HTTP 400 ("unknown variant image_url"). The working path in
 * that setup is to save the image to disk and let the agent use its own
 * vision pipeline (vision_analyze → documented OMLX fallback), which is
 * exactly what the agent requested when the inline path failed.
 *
 *   inline — image_url parts pass through untouched (vision-capable main
 *            model required).
 *   file   — each image is decoded, written to $HERMES_HOME/attachments/
 *            and replaced with a text reference the agent can analyze.
 *   auto   — inline only when the model advertises vision capability;
 *            otherwise file. Capability data is often absent, so auto
 *            safely defaults to file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MessagePart } from './api/types';

export type EffectiveImageMode = 'inline' | 'file';

export function resolveImageMode(
  mode: string,
  modelCaps?: Record<string, unknown>,
): EffectiveImageMode {
  if (mode === 'inline') return 'inline';
  if (mode === 'file') return 'file';
  // auto: inline only if the model advertises vision; else file.
  if (modelCaps) {
    for (const key of ['vision', 'image', 'images', 'multimodal']) {
      if (modelCaps[key] === true) return 'inline';
    }
  }
  return 'file';
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function decodeDataUrl(url: string): { mime: string; ext: string; data: Buffer } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  return { mime, ext: EXT_BY_MIME[mime] ?? 'img', data: Buffer.from(m[2], 'base64') };
}

export interface TransferResult {
  parts: MessagePart[];
  /** Absolute paths of images written to disk (file mode). */
  written: string[];
}

/**
 * Transform outbound message parts for the chosen mode.
 * In file mode each image becomes a text reference with explicit guidance
 * to use the agent's vision fallback chain.
 */
export function buildMessage(
  parts: MessagePart[],
  mode: EffectiveImageMode,
  attachDir: string,
  ts = Date.now(),
): TransferResult {
  if (mode === 'inline') return { parts, written: [] };

  const written: string[] = [];
  const imageRefs: string[] = [];
  const textParts: string[] = [];

  for (const p of parts) {
    if (p.type === 'text') {
      textParts.push(p.text);
      continue;
    }
    const dec = decodeDataUrl(p.image_url.url);
    if (!dec) {
      imageRefs.push('(an image could not be decoded)');
      continue;
    }
    fs.mkdirSync(attachDir, { recursive: true });
    const file = path.join(attachDir, `${ts}-${written.length}.${dec.ext}`);
    fs.writeFileSync(file, dec.data);
    written.push(file);
    imageRefs.push(file);
  }

  const out: MessagePart[] = [];
  const refText = imageRefs
    .map(
      (f) =>
        `[Image pasted: ${f} — if you need to see it, analyze it with vision_analyze; if that fails, use the documented OMLX vision fallback.]`,
    )
    .join('\n');
  const userText = textParts.join('\n\n');
  if (refText && userText) {
    out.push({ type: 'text', text: `${refText}\n\n${userText}` });
  } else if (refText) {
    out.push({ type: 'text', text: refText });
  } else if (userText) {
    out.push({ type: 'text', text: userText });
  }
  return { parts: out, written };
}
