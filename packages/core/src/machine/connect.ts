/**
 * Machine.connect on the machine itself: a TCP stream to a loopback port as a
 * MachineProcess (stdout carries what the port sends, write sends to it,
 * exited resolves when it closes). The Preview pane's relay (browser/preview.ts)
 * uses it for the hub's own machine and the daemon serves the connect RPC with it.
 */
import { connect as netConnect, type Socket } from 'node:net';
import type { MachineProcess } from './types';

export function checkPort(port: unknown): number {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw Object.assign(new Error(`Port ${String(port)} is not allowed: only loopback ports 1024 to 65535.`), { code: 'EACCES' });
  }
  return port;
}

/** Open 127.0.0.1:port, then ::1:port when IPv4 refuses (a dev server bound to ::1 only). */
export function loopbackProcess(port: number): MachineProcess {
  checkPort(port);
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (out = c) });
  const stderr = new ReadableStream<Uint8Array>({ start: (c) => void (err = c) });
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((r) => (resolveExit = r));
  let sock: Socket | undefined;
  let attempt: Socket | undefined;
  let done = false;
  const pending: Uint8Array[] = [];
  let endPending = false;
  const finish = (code: number | null, message?: string) => {
    if (done) return;
    done = true;
    if (message) {
      try {
        err.enqueue(new TextEncoder().encode(`${message}\n`));
      } catch {
        /* reader gone */
      }
    }
    for (const c of [out, err]) {
      try {
        c.close();
      } catch {
        /* closed */
      }
    }
    resolveExit(code);
  };
  const open = (host: string, fallback?: string) => {
    const s = netConnect({ host, port });
    attempt = s;
    s.once('connect', () => {
      if (done) return void s.destroy();
      sock = s;
      for (const b of pending.splice(0)) s.write(b);
      if (endPending) s.end();
    });
    s.on('data', (b: Buffer) => {
      try {
        out.enqueue(new Uint8Array(b));
      } catch {
        /* reader cancelled */
      }
    });
    s.once('error', (e: NodeJS.ErrnoException) => {
      if (!sock && fallback && e.code === 'ECONNREFUSED') return open(fallback);
      finish(null, `connect ${host}:${port}: ${e.code ?? e.message}`);
    });
    s.once('close', () => {
      if (sock === s) finish(0);
    });
  };
  open('127.0.0.1', '::1');
  return {
    pid: undefined,
    stdout,
    stderr,
    exited,
    write(data) {
      if (done) return;
      const b = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      if (sock) sock.write(b);
      else pending.push(b);
    },
    closeStdin() {
      if (done) return;
      if (sock) sock.end();
      else endPending = true;
    },
    kill() {
      attempt?.destroy();
      finish(0);
    },
  };
}
