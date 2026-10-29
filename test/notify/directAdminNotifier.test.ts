import { describe, expect, it } from 'vitest';
import { createDirectAdminNotifier } from '../../src/notify/directAdminNotifier.js';
import { harness, pushReasons, sentTexts, silent } from '../handlers/helpers.js';

describe('createDirectAdminNotifier', () => {
  it('pushes to every admin with reason admin_<kind>', async () => {
    const h = harness();
    const n = createDirectAdminNotifier({
      adminUserIds: ['U1', 'U2'],
      replier: h.replier,
      log: silent,
    });
    expect(await n.notify({ kind: 'triage', text: '分析結果', meta: { taskId: 't' } })).toBe(
      'pushed',
    );
    expect(h.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual(['U1', 'U2']);
    expect(sentTexts(h.api).map((s) => s.text)).toEqual(['分析結果', '分析結果']);
    expect(pushReasons(h.db)).toEqual(['admin_triage', 'admin_triage']);
  });

  it('one failing recipient does not stop the others; all failing → logged', async () => {
    const h = harness();
    h.api.pushMessage.mockImplementation(async (req) => {
      if (req.to === 'U1') throw new Error('blocked');
      return {};
    });
    const n = createDirectAdminNotifier({
      adminUserIds: ['U1', 'U2'],
      replier: h.replier,
      log: silent,
    });
    expect(await n.notify({ kind: 'incident', text: 'x' })).toBe('pushed');
    expect(pushReasons(h.db)).toEqual(['admin_incident']);

    h.api.pushMessage.mockRejectedValue(new Error('down'));
    await expect(n.notify({ kind: 'incident', text: 'x' })).resolves.toBe('logged');
  });

  it('empty allowlist → logged, nothing sent', async () => {
    const h = harness();
    const n = createDirectAdminNotifier({ adminUserIds: [], replier: h.replier, log: silent });
    expect(await n.notify({ kind: 'other', text: 'x' })).toBe('logged');
    expect(h.api.pushMessage).not.toHaveBeenCalled();
  });
});
