import type { Readable } from 'node:stream';
import type Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { PendingImagesRepo } from '../db/pendingImages.js';
import type { LineBlobApi } from '../line/client.js';
import { logger } from '../logger.js';

/**
 * SPEC-ADMIN §16: images an admin sends first are recorded as pending (LINE message id only) and
 * attached to the same user's next model-bound text in the same conversation. They are downloaded,
 * resized and base64-encoded in memory only at that point, one at a time, and never logged.
 */

/** §16.2 step 2: pending images older than this are dropped without a reply. */
export const PENDING_IMAGE_TTL_MS = 10 * 60_000;
/** §16.2 step 2: at most this many (the newest) go with one question. */
export const MAX_PENDING_IMAGES = 3;
/** §16.2 step 3: longest edge after resizing (never enlarged). */
export const IMAGE_MAX_EDGE = 1280;
export const IMAGE_JPEG_QUALITY = 80;
/** Downloads larger than this are treated as unreadable (container memory is 256 MB). */
export const IMAGE_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/**
 * §16.2 step 1 (DM): an image arriving within this window of the same user's previous pending DM
 * image is part of the same burst / LINE image set and gets no second `adminImageReceived`.
 */
export const IMAGE_ACK_BURST_MS = 10_000;

/** `dm` for direct messages, otherwise the groupId / roomId. */
export const DM_CONVERSATION = 'dm';

export interface PreparedImages {
  blocks: Anthropic.Beta.BetaImageBlockParam[];
  /** Pending images that could not be used (external provider, download or resize failure). */
  failed: number;
}

export interface ImageAttacher {
  /** Removes this user + conversation's fresh pending images and returns them ready for the model. */
  take(userId: string, conversation: string): Promise<PreparedImages>;
}

async function readLimited(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > maxBytes) {
      stream.destroy();
      throw new Error(`image larger than ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Long edge > `IMAGE_MAX_EDGE` → scaled down proportionally; smaller images keep their size.
 * Always re-encoded as JPEG (quality 80), EXIF orientation applied, transparency on white.
 * `sharp` is loaded lazily so a broken native build only disables images.
 */
export async function resizeImage(input: Buffer): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  sharp.cache(false);
  return sharp(input)
    .rotate()
    .resize({
      width: IMAGE_MAX_EDGE,
      height: IMAGE_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: IMAGE_JPEG_QUALITY })
    .toBuffer();
}

export function createImageAttacher(deps: {
  repo: PendingImagesRepo;
  blob: LineBlobApi;
  now?: () => Date;
  log?: Logger;
}): ImageAttacher {
  const { repo, blob } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? logger;

  return {
    async take(userId, conversation) {
      const rows = repo.take(userId, conversation, now(), PENDING_IMAGE_TTL_MS, MAX_PENDING_IMAGES);
      const blocks: Anthropic.Beta.BetaImageBlockParam[] = [];
      let failed = 0;
      // One at a time: only one decoded image is held in memory.
      for (const row of rows) {
        const meta = { userId, conversation, lineMessageId: row.line_message_id };
        if (row.content_provider !== 'line') {
          failed += 1;
          log.warn({ ...meta, contentProvider: row.content_provider }, 'pending image not on LINE');
          continue;
        }
        try {
          const raw = await readLimited(
            await blob.getMessageContent(row.line_message_id),
            IMAGE_MAX_DOWNLOAD_BYTES,
          );
          const jpeg = await resizeImage(raw);
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') },
          });
        } catch (err) {
          failed += 1;
          // Name and message only: never the image bytes or a response body.
          const e = err instanceof Error ? err : new Error(String(err));
          log.warn({ ...meta, errName: e.name, errMessage: e.message }, 'pending image unreadable');
        }
      }
      if (rows.length > 0) {
        log.info(
          { userId, conversation, attached: blocks.length, failed },
          'pending images attached',
        );
      }
      return { blocks, failed };
    },
  };
}

/**
 * Puts `images` before the text of the last (user) message. Messages from `toModelMessages` end
 * with a user turn; anything else is returned unchanged.
 */
export function withImages(
  messages: Anthropic.Beta.BetaMessageParam[],
  images: Anthropic.Beta.BetaImageBlockParam[],
): Anthropic.Beta.BetaMessageParam[] {
  if (images.length === 0 || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== 'user') return messages;
  const textBlocks: Anthropic.Beta.BetaContentBlockParam[] =
    typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
  return [...messages.slice(0, -1), { role: 'user', content: [...images, ...textBlocks] }];
}
