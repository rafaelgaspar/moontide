import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autostart } from '../dist/start.js';

function fakeStarter(result) {
  const calls = { start: 0 };
  return {
    calls,
    start() {
      calls.start += 1;
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

test('autostart: off unless MOONTIDE_AUTOSTART is exactly 1', async () => {
  for (const env of [{}, { MOONTIDE_AUTOSTART: '0' }, { MOONTIDE_AUTOSTART: 'true' }, { MOONTIDE_AUTOSTART: '' }]) {
    const starter = fakeStarter({});
    assert.equal(await autostart(starter, env), false, JSON.stringify(env));
    assert.equal(starter.calls.start, 0, JSON.stringify(env));
  }
});

test('autostart: MOONTIDE_AUTOSTART=1 starts Moontide once', async () => {
  const starter = fakeStarter({});
  assert.equal(await autostart(starter, { MOONTIDE_AUTOSTART: '1' }), true);
  assert.equal(starter.calls.start, 1);
});

test('autostart: a failed start is logged, not thrown, so the start tool can retry', async (t) => {
  const lines = [];
  const originalError = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  t.after(() => {
    console.error = originalError;
  });
  const starter = fakeStarter(new Error('port busy'));
  assert.equal(await autostart(starter, { MOONTIDE_AUTOSTART: '1' }), false);
  assert.deepEqual(lines, ['[moontide] Autostart failed: port busy']);
});
