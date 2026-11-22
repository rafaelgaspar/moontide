import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// MCP over Streamable HTTP, for running Moontide as a network service (MOONTIDE_MCP_HTTP_PORT) instead of
// a stdio child of one client. Stateless: every POST gets its own McpServer over the one shared Session and
// Starter, so every client drives the same music and page, and no session id can go stale across restarts.
// Moontide sends no server-initiated messages, so there is no GET stream to keep.

export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/healthz';
export const DEFAULT_MCP_HTTP_HOST = '127.0.0.1';
export const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;

export interface McpHttpServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

/** The MCP HTTP port from MOONTIDE_MCP_HTTP_PORT: undefined when unset or empty (stdio mode). */
export function parseMcpHttpPort(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const port = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`MOONTIDE_MCP_HTTP_PORT ${JSON.stringify(value)} is not a port number`);
  }
  return port;
}

function jsonRpcError(res: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MCP_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('request body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleMcpPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  createServer: () => McpServer,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonRpcError(res, 400, err instanceof Error ? err.message : String(err));
    return;
  }
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/** Serves MCP on POST /mcp and a liveness answer on GET /healthz. */
export function startMcpHttpServer(options: {
  createServer: () => McpServer;
  port: number;
  host?: string;
}): Promise<McpHttpServer> {
  const host = options.host ?? DEFAULT_MCP_HTTP_HOST;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === HEALTH_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(req.method === 'HEAD' ? undefined : 'ok\n');
      return;
    }
    if (pathname !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      jsonRpcError(res, 405, 'Method not allowed: this server is stateless and only accepts POST', { Allow: 'POST' });
      return;
    }
    handleMcpPost(req, res, options.createServer).catch((err: unknown) => {
      console.error(`[moontide] MCP HTTP request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        jsonRpcError(res, 500, 'Internal server error');
      } else {
        res.end();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      server.off('error', reject);
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : options.port;
      resolve({
        host,
        port,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections();
            server.close(() => res());
          }),
      });
    });
  });
}
