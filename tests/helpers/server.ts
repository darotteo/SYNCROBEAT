import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';

const root = path.resolve(import.meta.dirname, '../..');

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export interface RunningServer {
  url: string;
  wsUrl: string;
  proc: ChildProcess;
  stop: () => Promise<void>;
}

/** Starts the real server.ts in production mode on a free port (BATUTA_TEST_URL reuses an existing one). */
export async function startServer(): Promise<RunningServer> {
  if (process.env.BATUTA_TEST_URL) {
    const url = process.env.BATUTA_TEST_URL.replace(/\/$/, '');
    const ws = new URL('/api/ws', url);
    ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
    return { url, wsUrl: ws.toString(), proc: null as unknown as ChildProcess, stop: async () => {} };
  }
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'server.ts', '--prod'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout!.on('data', (d) => (output += d));
  proc.stderr!.on('data', (d) => (output += d));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start:\n' + output)), 30_000);
    proc.stdout!.on('data', () => {
      if (output.includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited (${code}):\n${output}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/api/ws`,
    proc,
    stop: () =>
      new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill();
      }),
  };
}

/** A WebSocket test client that records every message and can wait for one matching a predicate. */
export class Client {
  ws!: WebSocket;
  messages: any[] = [];
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];

  static async connect(wsUrl: string) {
    const c = new Client();
    c.ws = new WebSocket(wsUrl);
    c.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      c.messages.push(msg);
      c.waiters = c.waiters.filter((w) => {
        if (!w.pred(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
    await new Promise((resolve, reject) => {
      c.ws.once('open', resolve);
      c.ws.once('error', reject);
    });
    return c;
  }

  send(msg: object) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Resolves with the first message (already received after `since`, or future) matching `pred`. */
  waitFor(pred: (m: any) => boolean, { timeout = 3000, since = 0 } = {}): Promise<any> {
    const existing = this.messages.slice(since).find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for message. Got: ' + JSON.stringify(this.messages.slice(since)).slice(0, 800))), timeout);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }

  /** Sends and waits for the next message matching `pred`. */
  async request(msg: object, pred: (m: any) => boolean, timeout?: number) {
    const since = this.messages.length;
    this.send(msg);
    return this.waitFor(pred, { since, timeout });
  }

  /** Resolves true if no matching message arrives within `ms`. */
  async expectNothing(pred: (m: any) => boolean, ms = 300) {
    const since = this.messages.length;
    await new Promise((r) => setTimeout(r, ms));
    return !this.messages.slice(since).some(pred);
  }

  close() {
    this.ws.terminate();
  }
}

export async function join(wsUrl: string, roomId: string, clientId: string, instrument: string, extra: object = {}) {
  const c = await Client.connect(wsUrl);
  const msg = await c.request(
    { type: 'join', roomId, clientId, name: clientId, instrument, ...extra },
    (m) => (m.type === 'room_state' && m.yourId) || m.type === 'error'
  );
  return { c, msg, state: msg.state };
}

let roomCounter = 0;
export const newRoom = () => `T${Date.now().toString(36)}${(roomCounter++).toString(36)}`.toUpperCase();
