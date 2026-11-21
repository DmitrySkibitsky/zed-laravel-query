/** Minimal LSP client over stdio for end-to-end tests of the bundled server. */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class LspClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  readonly notifications: Array<{ method: string; params: any }> = [];
  /** Answers to server → client requests (e.g. workspace/configuration). */
  requestHandlers: Record<string, (params: any) => unknown> = {};

  constructor(command: string, args: string[]) {
    this.process = spawn(command, args, { stdio: 'pipe' });
    this.process.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.process.on('exit', () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error('server exited'));
      }
      this.pending.clear();
    });
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 10_000): Promise<T> {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async shutdown(): Promise<number | null> {
    await this.request('shutdown', null);
    this.notify('exit', null);
    return new Promise((resolve) => {
      if (this.process.exitCode !== null) {
        resolve(this.process.exitCode);
      } else {
        this.process.on('exit', (code) => resolve(code));
      }
    });
  }

  kill(): void {
    this.process.kill();
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.process.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString())?.[1]);
      if (this.buffer.length < headerEnd + 4 + length) {
        return;
      }
      const message = JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8'));
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      this.dispatch(message);
    }
  }

  private dispatch(message: any): void {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        pending?.reject(new Error(message.error.message));
      } else {
        pending?.resolve(message.result);
      }
    } else if (message.id !== undefined) {
      const handler = this.requestHandlers[message.method];
      this.send({ jsonrpc: '2.0', id: message.id, result: handler ? handler(message.params) : null });
    } else {
      this.notifications.push({ method: message.method, params: message.params });
    }
  }
}
