import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { MCPServerConfig } from "./types.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface Transport {
  start(): Promise<void>;
  send(msg: JsonRpcMessage): Promise<void>;
  onMessage(handler: (msg: JsonRpcResponse | JsonRpcNotification) => void): void;
  onError(handler: (err: Error) => void): void;
  onClose(handler: (code: number | null) => void): void;
  close(): Promise<void>;
}

export class StdioTransport implements Transport {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private messageHandler?: (msg: JsonRpcResponse | JsonRpcNotification) => void;
  private errorHandler?: (err: Error) => void;
  private closeHandler?: (code: number | null) => void;
  private stderrBuf = "";

  constructor(private cfg: MCPServerConfig) {}

  async start(): Promise<void> {
    if (!this.cfg.command) throw new Error("stdio transport requires 'command'");
    const env = { ...process.env, ...(this.cfg.env ?? {}) };
    const proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.proc = proc as ChildProcessWithoutNullStreams;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.feed(chunk));

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      this.stderrBuf += chunk;
      if (this.stderrBuf.length > 10_000) this.stderrBuf = this.stderrBuf.slice(-8_000);
    });

    proc.on("error", (err) => {
      this.errorHandler?.(err);
    });
    proc.on("close", (code) => {
      this.closeHandler?.(code);
    });
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
        this.messageHandler?.(msg);
      } catch (e) {
        this.errorHandler?.(new Error(`invalid JSON from server: ${(e as Error).message}`));
      }
    }
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    if (!this.proc || this.proc.killed) throw new Error("transport not started or closed");
    const line = JSON.stringify(msg) + "\n";
    return new Promise((resolve, reject) => {
      this.proc!.stdin.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  onMessage(handler: (msg: JsonRpcResponse | JsonRpcNotification) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }

  onClose(handler: (code: number | null) => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    return new Promise((resolve) => {
      const done = (): void => resolve();
      p.once("close", done);
      try { p.stdin.end(); } catch { /* ignore */ }
      const killTimer = setTimeout(() => {
        try { p.kill("SIGTERM"); } catch { /* ignore */ }
      }, 500);
      const hardKillTimer = setTimeout(() => {
        try { p.kill("SIGKILL"); } catch { /* ignore */ }
      }, 2000);
      p.once("close", () => {
        clearTimeout(killTimer);
        clearTimeout(hardKillTimer);
      });
    });
  }

  getStderr(): string {
    return this.stderrBuf;
  }
}
