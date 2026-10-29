import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const required = { LINE_CHANNEL_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'token' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig({ ...required });
    expect(cfg).toMatchObject({
      PORT: 8090,
      DATA_DIR: './data',
      LOG_LEVEL: 'info',
      CLASSIFIER_MODEL: 'claude-opus-5-5',
      HEALTH_CHECK_URL: 'https://petsnack-backend.onrender.com/health',
      HEALTH_CHECK_TIMEOUT_MS: 8000,
      HEALTH_CACHE_MS: 30000,
      REPLY_DEADLINE_MS: 10000,
      CONTEXT_MESSAGES: 6,
      TZ: 'Asia/Taipei',
    });
    expect(cfg.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('parses numbers from strings and treats empty strings as unset', () => {
    const cfg = loadConfig({ ...required, PORT: '9000', ANTHROPIC_API_KEY: '', DATA_DIR: '' });
    expect(cfg.PORT).toBe(9000);
    expect(cfg.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cfg.DATA_DIR).toBe('./data');
  });

  it('throws when LINE_CHANNEL_SECRET is missing', () => {
    expect(() => loadConfig({ LINE_CHANNEL_ACCESS_TOKEN: 'token' })).toThrow(/LINE_CHANNEL_SECRET/);
  });

  it('lists every invalid field', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(
      /PORT[\s\S]*LINE_CHANNEL_SECRET[\s\S]*LINE_CHANNEL_ACCESS_TOKEN/,
    );
  });
});
