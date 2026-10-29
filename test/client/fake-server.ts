import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
export type Handler = (req: Seen, res: ServerResponse, n: number) => void;

export interface FakeServer {
  url: string;
  seen: Seen[];
  close(): Promise<void>;
}

export async function startServer(handler: Handler): Promise<FakeServer> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(s);
      handler(s, res, seen.length);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export const TOKEN_OK = {
  access_token: 'ACC1',
  token_type: 'Bearer',
  expires_in: 900,
  refresh_token: 'REF1',
  scope: 'agent',
  device_id: 'dev-1',
  organization_slug: 'acme',
};
