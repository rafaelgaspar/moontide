import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseMcpHttpPort, startMcpHttpServer } from '../dist/http-transport.js';

const ACCEPT = 'application/json, text/event-stream';
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

/** POSTs one JSON-RPC message and returns the status and the JSON-RPC reply (JSON or a single SSE event). */
async function rpc(base, message, headers = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, ...headers },
    body: typeof message === 'string' ? message : JSON.stringify(message),
  });
  const text = await res.text();
  if (!text) {
    return { status: res.status, body: undefined };
  }
  const data = text.includes('data: ')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('')
    : text;
  return { status: res.status, body: JSON.parse(data) };
}

function toyServer() {
  const server = new McpServer({ name: 'toy', version: '1' });
  server.registerTool('ping', { description: 'ping' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  return server;
}

test('http transport: parseMcpHttpPort reads a port, or nothing for stdio', () => {
  assert.equal(parseMcpHttpPort(undefined), undefined);
  assert.equal(parseMcpHttpPort(''), undefined);
  assert.equal(parseMcpHttpPort(' 3000 '), 3000);
  assert.equal(parseMcpHttpPort('0'), 0);
  for (const bad of ['http', '-1', '65536', '30.5', '3000a']) {
    assert.throws(() => parseMcpHttpPort(bad), /MOONTIDE_MCP_HTTP_PORT/, bad);
  }
});

test('http transport: stateless POST /mcp, health check, and refusals', async (t) => {
  let created = 0;
  const web = await startMcpHttpServer({
    port: 0,
    createServer: () => {
      created += 1;
      return toyServer();
    },
  });
  t.after(() => web.close());
  const base = `http://127.0.0.1:${web.port}`;

  assert.equal(web.host, '127.0.0.1');
  const init = await rpc(base, INITIALIZE);
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, 'toy');

  // No session: a later request, even with a made-up or stale session id, is served on its own.
  for (const headers of [{}, { 'mcp-session-id': 'stale-from-before-a-restart' }]) {
    const list = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers);
    assert.equal(list.status, 200, JSON.stringify(headers));
    assert.deepEqual(list.body.result.tools.map((tool) => tool.name), ['ping']);
  }
  const call = await rpc(base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } });
  assert.equal(call.body.result.content[0].text, 'pong');
  assert.equal(created, 4, 'one McpServer per request');

  assert.equal((await rpc(base, '{not json')).status, 400);
  assert.equal((await fetch(`${base}/mcp`, { headers: { accept: ACCEPT } })).status, 405);
  assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE' })).status, 405);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok\n');
  assert.equal((await fetch(`${base}/other`)).status, 404);
});

test('http transport: MOONTIDE_MCP_HTTP_PORT runs Moontide as a service with stdin closed', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moontide-http-'));
  const child = spawn(process.execPath, [new URL('../dist/index.js', import.meta.url).pathname], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MOONTIDE_MCP_HTTP_PORT: '0', MOONTIDE_NO_BROWSER: '1', MOONTIDE_DATA_DIR: dataDir },
  });
  t.after(() => {
    child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  let stderr = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no MCP URL in stderr:\n${stderr}`)), 10000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = /MCP over Streamable HTTP: (http:\/\/127\.0\.0\.1:\d+)\/mcp/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('exit', (code) => reject(new Error(`exited ${code}:\n${stderr}`)));
  });

  // Closed stdin did not shut it down; it answers MCP over HTTP.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(child.exitCode, null, stderr);
  const init = await rpc(base, INITIALIZE);
  assert.equal(init.status, 200);
  const list = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.body.result.tools.some((tool) => tool.name === 'start'));

  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.match(stderr, /Shutting down \(SIGTERM\)/);
});
