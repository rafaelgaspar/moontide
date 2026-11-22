import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { startWebServer, isAllowedHost, parsePublicUrl, HOST } from '../dist/web-server.js';
import { Session } from '../dist/session.js';
import WebSocket from 'ws';

const PUBLIC = 'https://moontide.example.org';

function get(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port, path: '/', headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Resolves 'open' or the refusal status of a /ws upgrade sent with the given Host and Origin. */
function upgrade(port, host, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${HOST}:${port}/ws`, { headers: { host }, origin });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', () => {});
  });
}

async function quietly(t, fn) {
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });
  return fn();
}

test('public URL: parsePublicUrl accepts an http or https origin only', () => {
  assert.equal(parsePublicUrl('https://Moontide.Example.org').host, 'moontide.example.org');
  assert.equal(parsePublicUrl('https://moontide.example.org/').origin, PUBLIC);
  assert.equal(parsePublicUrl('http://10.0.0.5:8080').host, '10.0.0.5:8080');
  for (const bad of [
    'moontide.example.org',
    'ftp://moontide.example.org',
    'https://moontide.example.org/music',
    'https://moontide.example.org/?a=1',
    'https://moontide.example.org/#x',
    'https://user:pass@moontide.example.org',
  ]) {
    assert.throws(() => parsePublicUrl(bad), /public URL/, bad);
  }
});

test('public URL: isAllowedHost also accepts the public host, and only that host', () => {
  const port = 5757;
  const publicUrl = parsePublicUrl(PUBLIC);
  for (const host of ['moontide.example.org', 'MOONTIDE.example.org', `localhost:${port}`]) {
    assert.equal(isAllowedHost(host, port, publicUrl), true, host);
  }
  for (const host of ['moontide.example.org:443', 'moontide.example.org.', 'evil.example', `moontide.example.org:${port}`]) {
    assert.equal(isAllowedHost(host, port, publicUrl), false, host);
  }
  assert.equal(isAllowedHost('moontide.example.org', port), false, 'no public URL, no extra host');
  const withPort = parsePublicUrl('http://10.0.0.5:8080');
  assert.equal(isAllowedHost('10.0.0.5:8080', port, withPort), true);
  assert.equal(isAllowedHost('10.0.0.5', port, withPort), false);
});

test('public URL: the server reports the public URL and accepts its Host and Origin', async (t) => {
  const web = await quietly(t, () =>
    startWebServer({ session: new Session(), port: 0, folder: 'f', publicUrl: parsePublicUrl(PUBLIC) }),
  );
  t.after(() => web.close());

  assert.equal(web.url, PUBLIC);
  assert.equal(await get(web.port, 'moontide.example.org'), 200);
  assert.equal(await get(web.port, `localhost:${web.port}`), 200);
  assert.equal(await get(web.port, 'evil.example'), 403);

  assert.equal(await upgrade(web.port, 'moontide.example.org', PUBLIC), 'open');
  assert.equal(await upgrade(web.port, `localhost:${web.port}`, `http://localhost:${web.port}`), 'open');
  assert.equal(await upgrade(web.port, 'moontide.example.org', 'https://evil.example'), 403);
  assert.equal(await upgrade(web.port, 'moontide.example.org', 'http://moontide.example.org'), 403);
});

test('public URL: without one, the URL and the allowlists stay loopback only', async (t) => {
  const web = await quietly(t, () => startWebServer({ session: new Session(), port: 0, folder: 'f' }));
  t.after(() => web.close());

  assert.equal(web.url, `http://localhost:${web.port}`);
  assert.equal(await get(web.port, 'moontide.example.org'), 403);
  assert.equal(await upgrade(web.port, `localhost:${web.port}`, PUBLIC), 403);
});

test('public URL: the host option chooses the listen address', async (t) => {
  const web = await quietly(t, () => startWebServer({ session: new Session(), port: 0, folder: 'f', host: '0.0.0.0' }));
  t.after(() => web.close());

  assert.equal(await get(web.port, `localhost:${web.port}`), 200);
});

test('public URL: the page dials wss:// when it is served over https', () => {
  for (const file of ['page/main.js', 'page/load-failure-view.js']) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /new WebSocket\(\(location\.protocol === 'https:' \? 'wss:\/\/' : 'ws:\/\/'\) \+ location\.host \+ '\/ws'\)/, file);
    assert.doesNotMatch(source, /new WebSocket\('ws:\/\/'/, file);
  }
});
