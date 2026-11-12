import { Readable } from 'node:stream';
import type Anthropic from '@anthropic-ai/sdk';
import type { webhook } from '@line/bot-sdk';
import { pino } from 'pino';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  createImageAttacher,
  DM_CONVERSATION,
  IMAGE_ACK_BURST_MS,
  PENDING_IMAGE_TTL_MS,
  resizeImage,
  withImages,
} from '../../src/admin/images.js';
import { loadConfig } from '../../src/config.js';
import { NullGrokGateway } from '../../src/grok/gateway.js';
import { createAdminTextHandler } from '../../src/handlers/admin.js';
import { createAdminImageHandlers } from '../../src/handlers/adminImage.js';
import {
  createDispatcher,
  type GroupImageContext,
  type ImageMessageContext,
} from '../../src/handlers/dispatcher.js';
import { createGroupHandler } from '../../src/handlers/group.js';
import { JobQueue } from '../../src/jobs/queue.js';
import type { LineBlobApi } from '../../src/line/client.js';
import { createAdminProfile } from '../../src/profiles/admin.js';
import { createProfile } from '../../src/profiles/index.js';
import type { Shared } from '../../src/profiles/types.js';
import { texts } from '../../src/texts.js';
import {
  endTurn,
  fakeEnduser,
  fakeEshop,
  fakeModel,
  message,
  toolTurn,
  toolUse,
  type ScriptItem,
} from './fakes.js';
import {
  fakeHealth,
  harness,
  healthResult,
  inbound,
  sentTexts,
  silent,
  type Harness,
} from '../handlers/helpers.js';

const ADMIN = 'Uadmin';
const ADMIN2 = 'Uadmin2';
const STRANGER = 'Ustranger';
const GROUP = 'Cgroup0001';
const GROUP2 = 'Cgroup0002';
const MODEL = 'claude-opus-5-5';
const T0 = new Date('2026-11-12T08:00:00.000Z');

/** A solid-colour test image generated in memory (no real screenshots). */
async function makeImage(width: number, height: number, format: 'png' | 'jpeg' = 'png') {
  const img = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  });
  return format === 'png' ? img.png().toBuffer() : img.jpeg().toBuffer();
}

/** Fake LINE blob client: serves buffers by message id; unknown ids reject like a 404. */
function fakeBlob(images: Record<string, Buffer>) {
  const getMessageContent = vi.fn(async (id: string) => {
    const buf = images[id];
    if (!buf) throw new Error('Request failed with status code 404');
    return Readable.from([buf]);
  });
  const blob: LineBlobApi = { getMessageContent };
  return { blob, getMessageContent };
}

function captureLog() {
  const lines: string[] = [];
  const log = pino({ level: 'debug' }, { write: (s: string) => void lines.push(s) });
  return { log, lines };
}

/** Every image block in a request's messages, in order. */
function imageBlocks(params: Anthropic.Beta.MessageCreateParamsNonStreaming) {
  const out: Anthropic.Beta.BetaImageBlockParam[] = [];
  for (const m of params.messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) if (b.type === 'image') out.push(b);
  }
  return out;
}

function lastUserContent(params: Anthropic.Beta.MessageCreateParamsNonStreaming) {
  const users = params.messages.filter((m) => m.role === 'user');
  return users[users.length - 1].content;
}

function pendingRows(h: Harness) {
  return h.db.prepare('SELECT * FROM pending_images ORDER BY id').all() as {
    user_id: string;
    conversation: string;
    line_message_id: string;
    content_provider: string;
  }[];
}

interface QueryRow {
  user_id: string;
  text: string;
  tools: string;
  reply: string;
  image_count: number;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  model: string | null;
}

function queryRows(h: Harness) {
  return h.db.prepare('SELECT * FROM admin_queries ORDER BY id').all() as QueryRow[];
}

const CONFIG = {
  ADMIN_USER_IDS: [ADMIN, ADMIN2],
  GROUP_COMMAND_USER_IDS: [ADMIN, ADMIN2],
  ADMIN_MODEL: MODEL,
  ADMIN_MAX_TOOL_ROUNDS: 4,
  REPLY_DEADLINE_MS: 5000,
  CONTEXT_MESSAGES: 6,
  CONFIRMATION_TTL_MS: 600_000,
};

function setup(opts: { script?: ScriptItem[]; images?: Record<string, Buffer> } = {}) {
  const h = harness();
  const clock = { t: T0 };
  const now = () => clock.t;
  const { log, lines } = captureLog();
  const model = fakeModel(opts.script ?? []);
  const { blob, getMessageContent } = fakeBlob(opts.images ?? {});
  const attacher = createImageAttacher({ repo: h.repos.pendingImages, blob, now, log });
  const imageHandlers = createAdminImageHandlers({
    repos: h.repos,
    replier: h.replier,
    config: CONFIG,
    now,
    log,
  });
  const common = {
    repos: h.repos,
    replier: h.replier,
    health: fakeHealth(healthResult({ status: 'healthy' })),
    jobs: h.jobs,
    grok: { configured: true },
    eshop: fakeEshop(),
    enduser: fakeEnduser(),
    model: model.client,
    images: attacher,
    config: CONFIG,
    now,
    log,
  };
  const handleText = createAdminTextHandler(common);
  const handleGroupText = createGroupHandler(common);

  let n = 0;
  const dmImage = (
    id: string,
    userId = ADMIN,
    contentProvider: 'line' | 'external' = 'line',
  ): Promise<void> => {
    n += 1;
    h.repos.users.upsert({ userId });
    h.repos.messages.insert({ userId, direction: 'in', type: 'image', replyToken: `itok-${n}` });
    const ctx: ImageMessageContext = {
      userId,
      replyToken: `itok-${n}`,
      lineMessageId: id,
      contentProvider,
      event: {} as webhook.MessageEvent,
    };
    return imageHandlers.handleImage(ctx);
  };
  /** `userId: null` = LINE omitted the sender. */
  const groupImage = (id: string, userId: string | null = ADMIN, groupId = GROUP) => {
    const ctx: GroupImageContext = {
      groupId,
      sourceType: 'group',
      userId: userId ?? undefined,
      lineMessageId: id,
      contentProvider: 'line',
      event: {} as webhook.MessageEvent,
    };
    return imageHandlers.handleGroupImage(ctx);
  };
  const tag = (text: string, userId = ADMIN, groupId = GROUP) => {
    n += 1;
    return handleGroupText({
      groupId,
      sourceType: 'group',
      userId,
      text: `@bot ${text}`,
      mentionees: [{ type: 'user', index: 0, length: 4, isSelf: true, userId: 'Ubot' }],
      replyToken: `gtok-${n}`,
      event: {} as webhook.MessageEvent,
    });
  };
  const dmText = (text: string, userId = ADMIN) => handleText(inbound(h.repos, text, { userId }));
  return {
    h,
    clock,
    model,
    getMessageContent,
    lines,
    dmImage,
    groupImage,
    tag,
    dmText,
  };
}

describe('resizeImage (SPEC-ADMIN §16.2 step 3)', () => {
  it('scales the long edge down to 1280 proportionally and outputs JPEG', async () => {
    const out = await resizeImage(await makeImage(3000, 1500));
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([1280, 640]);
  });

  it('handles a portrait image by its height', async () => {
    const meta = await sharp(await resizeImage(await makeImage(1000, 2560))).metadata();
    expect([meta.width, meta.height]).toEqual([500, 1280]);
  });

  it('never enlarges a small image but still re-encodes it as JPEG', async () => {
    const meta = await sharp(await resizeImage(await makeImage(800, 600))).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([800, 600]);
  });

  it('rejects data that is not an image', async () => {
    await expect(resizeImage(Buffer.from('not an image'))).rejects.toThrow();
  });
});

describe('withImages', () => {
  const img: Anthropic.Beta.BetaImageBlockParam = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
  };

  it('puts the images before the text of the last user message', () => {
    const out = withImages(
      [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: '這筆出貨了嗎' },
      ],
      [img],
    );
    expect(out[0]).toEqual({ role: 'user', content: 'earlier' });
    expect(out[2]).toEqual({
      role: 'user',
      content: [img, { type: 'text', text: '這筆出貨了嗎' }],
    });
  });

  it('returns the messages unchanged without images', () => {
    const msgs: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: 'hi' }];
    expect(withImages(msgs, [])).toBe(msgs);
  });
});

describe('pending_images repo', () => {
  it('keeps the newest 3 per user + conversation and takes them oldest first', () => {
    const h = harness();
    const repo = h.repos.pendingImages;
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
      repo.add({
        userId: ADMIN,
        conversation: DM_CONVERSATION,
        lineMessageId: id,
        contentProvider: 'line',
        now: new Date(T0.getTime() + i * 1000),
        keep: 3,
      });
    }
    repo.add({
      userId: ADMIN,
      conversation: GROUP,
      lineMessageId: 'g',
      contentProvider: 'line',
      now: T0,
      keep: 3,
    });
    expect(pendingRows(h).map((r) => r.line_message_id)).toEqual(['b', 'c', 'd', 'g']);
    const taken = repo.take(ADMIN, DM_CONVERSATION, T0, PENDING_IMAGE_TTL_MS, 3);
    expect(taken.map((r) => r.line_message_id)).toEqual(['b', 'c', 'd']);
    expect(pendingRows(h).map((r) => r.line_message_id)).toEqual(['g']);
  });

  it('ignores a redelivered message id and purges expired rows', () => {
    const h = harness();
    const repo = h.repos.pendingImages;
    const add = (id: string, now: Date) =>
      repo.add({
        userId: ADMIN,
        conversation: GROUP,
        lineMessageId: id,
        contentProvider: 'line',
        now,
        keep: 3,
      });
    add('x', T0);
    add('x', T0);
    add('y', new Date(T0.getTime() + PENDING_IMAGE_TTL_MS));
    expect(pendingRows(h)).toHaveLength(2);
    expect(
      repo.purgeExpired(new Date(T0.getTime() + PENDING_IMAGE_TTL_MS), PENDING_IMAGE_TTL_MS),
    ).toBe(1);
    expect(pendingRows(h).map((r) => r.line_message_id)).toEqual(['y']);
  });
});

describe('DM images (SPEC-ADMIN §16.2)', () => {
  it('records an allowlisted image as pending without downloading and acknowledges once', async () => {
    const s = setup();
    await s.dmImage('m1');
    expect(s.getMessageContent).not.toHaveBeenCalled();
    expect(pendingRows(s.h)).toEqual([
      expect.objectContaining({
        user_id: ADMIN,
        conversation: 'dm',
        line_message_id: 'm1',
        content_provider: 'line',
      }),
    ]);
    expect(sentTexts(s.h.api)).toEqual([{ via: 'reply', text: texts.adminImageReceived }]);
    // The message row is the usual type=image row with no content.
    const rows = s.h.db.prepare("SELECT type, text FROM messages WHERE direction = 'in'").all() as {
      type: string;
      text: string | null;
    }[];
    expect(rows).toEqual([{ type: 'image', text: null }]);
  });

  it('does not acknowledge again within a burst (image set), but does after it', async () => {
    const s = setup();
    await s.dmImage('m1');
    s.clock.t = new Date(T0.getTime() + 2000);
    await s.dmImage('m2');
    s.clock.t = new Date(T0.getTime() + 4000);
    await s.dmImage('m3');
    expect(sentTexts(s.h.api)).toHaveLength(1);
    s.clock.t = new Date(T0.getTime() + 4000 + IMAGE_ACK_BURST_MS);
    await s.dmImage('m4');
    expect(sentTexts(s.h.api).map((m) => m.text)).toEqual([
      texts.adminImageReceived,
      texts.adminImageReceived,
    ]);
  });

  it('answers a non-allowlisted image with adminOnly and records nothing', async () => {
    const s = setup();
    await s.dmImage('m1', STRANGER);
    expect(sentTexts(s.h.api)).toEqual([{ via: 'reply', text: texts.adminOnly }]);
    expect(pendingRows(s.h)).toEqual([]);
  });

  it('attaches the image before the next text, consumes it and records usage', async () => {
    const img = await makeImage(2560, 1440);
    const s = setup({
      script: [
        {
          ...toolTurn(
            toolUse('t1', 'get_order', { orderId: '#20261029-VXJG7AZY', reveal_pii: false }),
          ),
          usage: message({}).usage,
        },
        {
          ...endTurn('已出貨'),
          model: 'claude-opus-5',
          usage: {
            ...message({}).usage,
            input_tokens: 50,
            cache_read_input_tokens: 1500,
            cache_creation_input_tokens: 0,
            output_tokens: 30,
          },
        },
        endTurn('那一筆查不到'),
      ],
      images: { m1: img },
    });
    // Round 1 usage (fake default): input 100, output 20, no cache.
    const first = s.model;
    await s.dmImage('m1');
    s.clock.t = new Date(T0.getTime() + 60_000);
    await s.dmText('這筆出貨了嗎');

    expect(s.getMessageContent).toHaveBeenCalledWith('m1');
    const content = lastUserContent(first.calls[0].params);
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Anthropic.Beta.BetaContentBlockParam[];
    expect(blocks[0].type).toBe('image');
    expect(blocks[blocks.length - 1]).toEqual({ type: 'text', text: '這筆出貨了嗎' });
    const source = (blocks[0] as Anthropic.Beta.BetaImageBlockParam).source;
    expect(source).toMatchObject({ type: 'base64', media_type: 'image/jpeg' });
    const meta = await sharp(Buffer.from((source as { data: string }).data, 'base64')).metadata();
    expect([meta.width, meta.height]).toEqual([1280, 720]);
    // Round 2 resends the same prefix (image included) so it can be read from the cache.
    expect(imageBlocks(first.calls[1].params)).toHaveLength(1);
    expect(pendingRows(s.h)).toEqual([]);
    expect(sentTexts(s.h.api).map((m) => m.text)).toEqual([texts.adminImageReceived, '已出貨']);

    const [row] = queryRows(s.h);
    expect(row).toMatchObject({
      image_count: 1,
      input_tokens: 150,
      cache_read_tokens: 1500,
      cache_write_tokens: 0,
      output_tokens: 50,
      model: 'claude-opus-5',
      reply: '已出貨',
    });

    // A follow-up carries text context only (§16.2 step 6).
    await s.dmText('那另一筆呢');
    expect(imageBlocks(first.calls[2].params)).toEqual([]);
    expect(queryRows(s.h)[1]).toMatchObject({ image_count: 0, input_tokens: 100 });

    // Nothing image-like leaked into the log, admin_queries or messages.
    const b64 = (source as { data: string }).data.slice(0, 64);
    expect(s.lines.join('\n')).not.toContain(b64);
    expect(JSON.stringify(queryRows(s.h))).not.toContain(b64);
    const allMessages = JSON.stringify(s.h.db.prepare('SELECT * FROM messages').all());
    expect(allMessages).not.toContain(b64);
    // The per-round usage log carries imageCount.
    const usageLogs = s.lines
      .map((l) => JSON.parse(l) as { msg: string; imageCount?: number })
      .filter((l) => l.msg === 'admin model usage');
    expect(usageLogs.map((l) => l.imageCount)).toEqual([1, 1, 0]);
  });

  it('quick commands do not consume pending images', async () => {
    const s = setup({ script: [endTurn('看到了')], images: { m1: await makeImage(100, 100) } });
    await s.dmImage('m1');
    await s.dmText('待回覆');
    await s.dmText('工單 T001');
    expect(s.model.calls).toHaveLength(0);
    expect(s.getMessageContent).not.toHaveBeenCalled();
    expect(pendingRows(s.h)).toHaveLength(1);
    // Intercepted commands record no model usage.
    expect(queryRows(s.h)[0]).toMatchObject({ image_count: 0, input_tokens: null, model: null });
    await s.dmText('這筆出貨了嗎');
    expect(imageBlocks(s.model.calls[0].params)).toHaveLength(1);
    expect(pendingRows(s.h)).toEqual([]);
  });

  it('a pending image older than 10 minutes is purged and not attached', async () => {
    const s = setup({ script: [endTurn('查無')], images: { m1: await makeImage(100, 100) } });
    await s.dmImage('m1');
    s.clock.t = new Date(T0.getTime() + PENDING_IMAGE_TTL_MS + 1000);
    await s.dmText('這筆出貨了嗎');
    expect(s.getMessageContent).not.toHaveBeenCalled();
    expect(imageBlocks(s.model.calls[0].params)).toEqual([]);
    expect(pendingRows(s.h)).toEqual([]);
    expect(sentTexts(s.h.api).map((m) => m.text)).toEqual([texts.adminImageReceived, '查無']);
  });

  it('attaches at most the newest 3 images', async () => {
    const img = await makeImage(64, 64);
    const s = setup({
      script: [endTurn('ok')],
      images: { m1: img, m2: img, m3: img, m4: img },
    });
    for (const id of ['m1', 'm2', 'm3', 'm4']) await s.dmImage(id);
    await s.dmText('這幾筆出貨了嗎');
    expect(s.getMessageContent.mock.calls.map((c) => c[0])).toEqual(['m2', 'm3', 'm4']);
    expect(imageBlocks(s.model.calls[0].params)).toHaveLength(3);
    expect(queryRows(s.h)[0].image_count).toBe(3);
  });

  it('skips unreadable images and prefixes the reply with adminImageFailed', async () => {
    const s = setup({
      script: [endTurn('只看到一張')],
      images: { ok: await makeImage(64, 64), broken: Buffer.from('not an image') },
    });
    await s.dmImage('ok');
    await s.dmImage('missing'); // download fails (404)
    await s.dmImage('broken'); // resize fails
    await s.dmImage('ext', ADMIN, 'external'); // not downloadable at all
    await s.dmText('這些出貨了嗎');
    expect(s.getMessageContent.mock.calls.map((c) => c[0])).toEqual(['missing', 'broken']);
    expect(imageBlocks(s.model.calls[0].params)).toHaveLength(0);
    // Newest 3 are missing / broken / ext: none usable.
    const replies = sentTexts(s.h.api).map((m) => m.text);
    expect(replies[replies.length - 1]).toBe(`${texts.adminImageFailed}\n只看到一張`);
    expect(queryRows(s.h)[0].image_count).toBe(0);
    expect(s.lines.some((l) => l.includes('pending image unreadable'))).toBe(true);
    expect(s.lines.some((l) => l.includes('pending image not on LINE'))).toBe(true);
  });

  it('keeps usable images when another one fails', async () => {
    const s = setup({ script: [endTurn('ok')], images: { a: await makeImage(64, 64) } });
    await s.dmImage('a');
    await s.dmImage('gone');
    await s.dmText('這筆呢');
    expect(imageBlocks(s.model.calls[0].params)).toHaveLength(1);
    expect(sentTexts(s.h.api).pop()?.text).toBe(`${texts.adminImageFailed}\nok`);
    expect(queryRows(s.h)[0].image_count).toBe(1);
  });

  it('does not attach another admin’s DM image or a group image to a DM', async () => {
    const s = setup({ script: [endTurn('ok')], images: { a: await makeImage(64, 64) } });
    await s.dmImage('a', ADMIN2);
    await s.groupImage('g1', ADMIN);
    await s.dmText('這筆出貨了嗎');
    expect(imageBlocks(s.model.calls[0].params)).toEqual([]);
    expect(pendingRows(s.h).map((r) => r.line_message_id)).toEqual(['a', 'g1']);
  });
});

describe('group images (SPEC-ADMIN §16.2)', () => {
  it('records an allowlisted group image silently and ignores everyone else', async () => {
    const s = setup();
    await s.groupImage('g1');
    await s.groupImage('g2', STRANGER);
    await s.groupImage('g3', null);
    expect(sentTexts(s.h.api)).toEqual([]);
    expect(pendingRows(s.h)).toEqual([
      expect.objectContaining({ user_id: ADMIN, conversation: GROUP, line_message_id: 'g1' }),
    ]);
  });

  it('the sender’s tagged query in the same group attaches it; context and logs stay text-only', async () => {
    const s = setup({
      script: [endTurn('已出貨'), endTurn('另一筆未出貨')],
      images: { g1: await makeImage(2000, 1000) },
    });
    await s.groupImage('g1');
    await s.tag('這筆出貨了嗎');
    const params = s.model.calls[0].params;
    expect(imageBlocks(params)).toHaveLength(1);
    expect((lastUserContent(params) as Anthropic.Beta.BetaContentBlockParam[])[0].type).toBe(
      'image',
    );
    expect(pendingRows(s.h)).toEqual([]);
    expect(sentTexts(s.h.api)).toEqual([{ via: 'reply', text: '已出貨' }]);
    expect(queryRows(s.h)[0]).toMatchObject({ image_count: 1, input_tokens: 100, model: MODEL });
    const ctxRows = s.h.db.prepare('SELECT direction, text FROM group_context ORDER BY id').all();
    expect(ctxRows).toEqual([
      { direction: 'in', text: '這筆出貨了嗎' },
      { direction: 'out', text: '已出貨' },
    ]);
    await s.tag('那另一筆呢');
    expect(imageBlocks(s.model.calls[1].params)).toEqual([]);
  });

  it('does not attach another member’s image, another group’s image or a DM image', async () => {
    const s = setup({ script: [endTurn('ok')], images: { x: await makeImage(64, 64) } });
    await s.groupImage('x', ADMIN2);
    await s.groupImage('y', ADMIN, GROUP2);
    await s.dmImage('z');
    await s.tag('這筆出貨了嗎');
    expect(imageBlocks(s.model.calls[0].params)).toEqual([]);
    expect(s.getMessageContent).not.toHaveBeenCalled();
    expect(pendingRows(s.h).map((r) => r.line_message_id)).toEqual(['x', 'y', 'z']);
  });

  it('/bug and an empty tag do not consume pending images', async () => {
    const s = setup({ script: [endTurn('ok')], images: { g1: await makeImage(64, 64) } });
    await s.groupImage('g1');
    await s.tag('/bug 結帳頁按 LINE Pay 沒反應');
    await s.tag('');
    expect(s.model.calls).toHaveLength(0);
    expect(pendingRows(s.h)).toHaveLength(1);
    await s.tag('這筆出貨了嗎');
    expect(imageBlocks(s.model.calls[0].params)).toHaveLength(1);
  });

  it('prefixes the group reply when an image cannot be read, but keeps group_context clean', async () => {
    const s = setup({ script: [endTurn('只依文字')] });
    await s.groupImage('gone');
    await s.tag('這筆出貨了嗎');
    expect(sentTexts(s.h.api)).toEqual([
      { via: 'reply', text: `${texts.adminImageFailed}\n只依文字` },
    ]);
    const out = s.h.db.prepare("SELECT text FROM group_context WHERE direction = 'out'").get() as {
      text: string;
    };
    expect(out.text).toBe('只依文字');
  });
});

describe('dispatcher image routing', () => {
  const base = {
    timestamp: 1700000000000,
    mode: 'active' as const,
    deliveryContext: { isRedelivery: false },
    webhookEventId: 'e1',
    replyToken: 'tok',
  };
  const image = (provider: 'line' | 'external' = 'line'): webhook.ImageMessageContent => ({
    type: 'image',
    id: 'img1',
    quoteToken: 'q',
    contentProvider: { type: provider },
  });
  const ev = (source: webhook.Source, provider?: 'line' | 'external'): webhook.MessageEvent => ({
    ...base,
    type: 'message',
    source,
    message: image(provider),
  });

  function build(withHooks: boolean) {
    const h = harness();
    const handleText = vi.fn(async () => {});
    const handleGroupText = vi.fn(async () => {});
    const handleImage = vi.fn<(ctx: ImageMessageContext) => Promise<void>>(async () => {});
    const handleGroupImage = vi.fn<(ctx: GroupImageContext) => Promise<void>>(async () => {});
    const dispatch = createDispatcher({
      repos: h.repos,
      replier: h.replier,
      handleText,
      handleGroupText,
      ...(withHooks ? { handleImage, handleGroupImage } : {}),
      welcomeText: () => texts.welcomeFallback,
      log: silent,
    });
    return { h, dispatch, handleText, handleGroupText, handleImage, handleGroupImage };
  }

  it('without image hooks (enduser / staff): DM image gets nonTextMessage, group image is ignored', async () => {
    const d = build(false);
    await d.dispatch(ev({ type: 'user', userId: 'U1' }));
    await d.dispatch(ev({ type: 'group', groupId: GROUP, userId: 'U1' }));
    expect(sentTexts(d.h.api)).toEqual([{ via: 'reply', text: texts.nonTextMessage }]);
    expect(d.handleGroupText).not.toHaveBeenCalled();
    expect(d.handleText).not.toHaveBeenCalled();
  });

  it('with image hooks: DM image is stored as type=image and routed with its message id', async () => {
    const d = build(true);
    await d.dispatch(ev({ type: 'user', userId: 'U1' }, 'external'));
    expect(d.handleImage).toHaveBeenCalledTimes(1);
    expect(d.handleImage.mock.calls[0][0]).toMatchObject({
      userId: 'U1',
      replyToken: 'tok',
      lineMessageId: 'img1',
      contentProvider: 'external',
    });
    expect(sentTexts(d.h.api)).toEqual([]);
    const rows = d.h.repos.messages.recent('U1', 5);
    expect(rows).toEqual([expect.objectContaining({ type: 'image', text: null })]);
  });

  it('with image hooks: group and room images go to handleGroupImage', async () => {
    const d = build(true);
    await d.dispatch(ev({ type: 'group', groupId: GROUP, userId: 'U1' }));
    await d.dispatch(ev({ type: 'room', roomId: 'Rroom1', userId: 'U2' }));
    expect(d.handleGroupImage.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({
        groupId: GROUP,
        sourceType: 'group',
        userId: 'U1',
        lineMessageId: 'img1',
      }),
      expect.objectContaining({ groupId: 'Rroom1', sourceType: 'room', userId: 'U2' }),
    ]);
    expect(d.handleGroupText).not.toHaveBeenCalled();
    expect(sentTexts(d.h.api)).toEqual([]);
  });
});

describe('profiles', () => {
  const baseShared = (env: Record<string, string>): Shared & { h: Harness } => {
    const h = harness();
    return {
      h,
      config: loadConfig(env),
      db: h.db,
      repos: h.repos,
      replier: h.replier,
      jobs: new JobQueue(h.repos.jobs, { maxAttempts: 1 }),
      grok: new NullGrokGateway(),
      health: fakeHealth(healthResult({ status: 'healthy' })),
      logger: silent,
    };
  };

  it('only the admin profile handles images', () => {
    const enduser = createProfile(
      'enduser',
      baseShared({ LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't' }),
    );
    const staff = createProfile(
      'staff',
      baseShared({
        LINE_CHANNEL_SECRET: 's',
        LINE_CHANNEL_ACCESS_TOKEN: 't',
        BOT_PROFILE: 'staff',
        STAFF_ADMIN_USER_IDS: 'Ustaffadmin',
        STAFF_GROUP_IDS: GROUP,
      }),
    );
    expect(enduser.handleImage).toBeUndefined();
    expect(enduser.handleGroupImage).toBeUndefined();
    expect(staff.handleImage).toBeUndefined();
    expect(staff.handleGroupImage).toBeUndefined();
  });

  it('admin profile acknowledges a DM image and purges expired pending images on start', async () => {
    const shared = baseShared({
      LINE_CHANNEL_SECRET: 's',
      LINE_CHANNEL_ACCESS_TOKEN: 't',
      BOT_PROFILE: 'admin',
      ADMIN_USER_IDS: ADMIN,
      ESHOP_BOT_USERNAME: 'bot',
      ESHOP_BOT_PASSWORD: 'pw',
      ANTHROPIC_API_KEY: 'sk-test',
      ENDUSER_INTERNAL_URL: 'http://127.0.0.1:1',
    });
    shared.lineBlob = fakeBlob({}).blob;
    shared.repos.pendingImages.add({
      userId: 'Uold',
      conversation: 'dm',
      lineMessageId: 'old',
      contentProvider: 'line',
      now: new Date(Date.now() - PENDING_IMAGE_TTL_MS - 1000),
      keep: 3,
    });
    const profile = createAdminProfile(shared);
    const dispatch = createDispatcher({
      repos: shared.repos,
      replier: shared.replier,
      handleText: profile.handleText,
      handleImage: profile.handleImage,
      handleGroupImage: profile.handleGroupImage,
      welcomeText: profile.welcomeText,
      log: silent,
    });
    await profile.start?.();
    await profile.stop?.();
    await shared.jobs.stop();
    await dispatch({
      timestamp: 1700000000000,
      mode: 'active',
      deliveryContext: { isRedelivery: false },
      webhookEventId: 'e1',
      replyToken: 'tok',
      type: 'message',
      source: { type: 'user', userId: ADMIN },
      message: { type: 'image', id: 'img9', quoteToken: 'q', contentProvider: { type: 'line' } },
    });
    const rows = shared.db
      .prepare('SELECT line_message_id FROM pending_images ORDER BY id')
      .all() as { line_message_id: string }[];
    expect(rows.map((r) => r.line_message_id)).toEqual(['img9']);
    expect(sentTexts(shared.h.api)).toEqual([{ via: 'reply', text: texts.adminImageReceived }]);
  });
});
