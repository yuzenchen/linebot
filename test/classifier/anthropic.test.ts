import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicClassifier,
  buildMessages,
  type ParseClient,
} from '../../src/classifier/anthropic.js';
import { FallbackClassifier, createClassifier } from '../../src/classifier/index.js';
import { RuleClassifier } from '../../src/classifier/rule.js';

const parsed = {
  category: 'kb_answer' as const,
  confidence: 0.95,
  answer: '有的，篩選選「貓咪」就能看到。',
  reason: '知識庫有貓咪商品分類',
};

const fixture = (over: Record<string, unknown> = {}) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'test-model',
  content: [{ type: 'text', text: JSON.stringify(parsed), parsed_output: parsed }],
  parsed_output: parsed,
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 12,
    output_tokens: 40,
    cache_read_input_tokens: 3000,
    cache_creation_input_tokens: 0,
  },
  ...over,
});

type CapturedRequest = {
  model: string;
  max_tokens: number;
  output_config: { effort: string; format: { type: string } };
  system: { text: string; cache_control?: { type: string } }[];
  messages: { role: string; content: string }[];
  temperature?: unknown;
  tool_choice?: unknown;
};

function fakeClient(impl: () => Promise<unknown>) {
  const parse = vi.fn(impl);
  return { client: { messages: { parse } } as unknown as ParseClient, parse };
}

const log = () => ({ info: vi.fn(), warn: vi.fn() });

describe('buildMessages', () => {
  it('merges same-role turns and starts with user', () => {
    const msgs = buildMessages({
      text: 'new',
      context: [
        { role: 'assistant', text: 'welcome' },
        { role: 'user', text: 'a' },
        { role: 'user', text: 'b' },
        { role: 'assistant', text: 'c' },
      ],
    });
    expect(msgs).toEqual([
      { role: 'user', content: 'a\nb' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'new' },
    ]);
  });

  it('merges a trailing user context turn with the new message', () => {
    const msgs = buildMessages({ text: 'two', context: [{ role: 'user', text: 'one' }] });
    expect(msgs).toEqual([{ role: 'user', content: 'one\ntwo' }]);
  });
});

describe('AnthropicClassifier', () => {
  it('sends the documented request shape and maps the parsed output', async () => {
    const { client, parse } = fakeClient(async () => fixture());
    const l = log();
    const c = new AnthropicClassifier({ client, model: 'm', knowledgeText: 'KB', log: l });
    const r = await c.classify({
      text: '有貓咪零食嗎',
      context: [
        { role: 'user', text: 'u1' },
        { role: 'user', text: 'u2' },
        { role: 'assistant', text: 'a1' },
      ],
    });

    expect(r).toMatchObject({ ...parsed, classifier: 'anthropic' });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);

    const [req, opts] = parse.mock.calls[0] as unknown as [
      CapturedRequest,
      Record<string, unknown>,
    ];
    expect(req.model).toBe('m');
    expect(req.max_tokens).toBe(1024);
    expect(req.output_config.effort).toBe('low');
    expect(req.output_config.format.type).toBe('json_schema');
    expect(req.system[1].cache_control?.type).toBe('ephemeral');
    expect(req.system[1].text).toContain('KB');
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(req.messages[0].content).toBe('u1\nu2');
    expect(req.temperature).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
    expect(opts.timeout).toBe(20000);

    expect(l.info).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({ cache_read_input_tokens: 3000, output_tokens: 40 }),
      }),
      expect.any(String),
    );
  });

  it('throws when the client rejects', async () => {
    const { client } = fakeClient(async () => {
      throw new Error('boom');
    });
    const c = new AnthropicClassifier({ client, model: 'm', knowledgeText: 'KB' });
    await expect(c.classify({ text: 'x', context: [] })).rejects.toThrow('boom');
  });

  it('throws on refusal stop reason', async () => {
    const { client } = fakeClient(async () =>
      fixture({ stop_reason: 'refusal', parsed_output: null }),
    );
    const c = new AnthropicClassifier({ client, model: 'm', knowledgeText: 'KB' });
    await expect(c.classify({ text: 'x', context: [] })).rejects.toThrow(/refusal/);
  });

  it('throws when parsed output fails the schema', async () => {
    const { client } = fakeClient(async () =>
      fixture({ parsed_output: { ...parsed, confidence: 2 } }),
    );
    const c = new AnthropicClassifier({ client, model: 'm', knowledgeText: 'KB' });
    await expect(c.classify({ text: 'x', context: [] })).rejects.toThrow();
  });
});

describe('FallbackClassifier', () => {
  it('falls back to rule with classifier=rule and logs a warning', async () => {
    const { client } = fakeClient(async () => {
      throw new Error('api down');
    });
    const l = log();
    const fb = new FallbackClassifier(
      new AnthropicClassifier({ client, model: 'm', knowledgeText: 'KB' }),
      new RuleClassifier(),
      l,
    );
    const r = await fb.classify({ text: '網站打不開', context: [] });
    expect(r).toMatchObject({ category: 'incident_report', classifier: 'rule' });
    expect(l.warn).toHaveBeenCalledOnce();
  });
});

describe('createClassifier', () => {
  it('without apiKey uses rule only and normalizes', async () => {
    const c = createClassifier({ model: 'm', knowledgeText: 'KB' });
    const r = await c.classify({ text: '訂單怎麼查', context: [] });
    expect(r).toMatchObject({ category: 'service_related', classifier: 'rule' });
  });
});
