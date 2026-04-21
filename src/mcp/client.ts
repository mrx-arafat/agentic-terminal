import type { MCPServerConfig, MCPToolDef } from "./types.js";
import {
  StdioTransport,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification,
  type Transport,
} from "./transport.js";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "agentic-terminal";
const CLIENT_VERSION = "0.3.1";
const DEFAULT_TIMEOUT_MS = 30_000;

export type ClientStatus = "idle" | "connecting" | "ready" | "error" | "closed";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class MCPClient {
  readonly name: string;
  private transport: Transport;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private tools: MCPToolDef[] = [];
  status: ClientStatus = "idle";
  lastError?: string;

  constructor(name: string, cfg: MCPServerConfig) {
    this.name = name;
    if (cfg.url) {
      throw new Error("HTTP/SSE MCP transport not yet supported; use stdio (command+args)");
    }
    if (!cfg.command) {
      throw new Error("MCP server config requires either 'command' (stdio) or 'url' (http)");
    }
    this.transport = new StdioTransport(cfg);
    this.transport.onMessage((m) => this.handleMessage(m));
    this.transport.onError((e) => {
      this.lastError = e.message;
      this.rejectAll(new Error(`transport error: ${e.message}`));
    });
    this.transport.onClose(() => {
      this.status = "closed";
      this.rejectAll(new Error("transport closed"));
    });
  }

  async connect(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    this.status = "connecting";
    try {
      await this.transport.start();
      const initResult = await this.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
        },
        timeoutMs,
      );
      void initResult;
      await this.notify("notifications/initialized", {});
      await this.refreshTools(timeoutMs);
      this.status = "ready";
    } catch (e) {
      this.status = "error";
      this.lastError = (e as Error).message;
      await this.close().catch(() => undefined);
      throw e;
    }
  }

  async refreshTools(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<MCPToolDef[]> {
    const res = await this.request("tools/list", {}, timeoutMs);
    const raw = (res as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> })?.tools ?? [];
    this.tools = raw.map((t) => ({
      server: this.name,
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
    return this.tools;
  }

  getTools(): MCPToolDef[] {
    return this.tools.slice();
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    if (this.status !== "ready") throw new Error(`MCP client '${this.name}' not ready (status=${this.status})`);
    const res = await this.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
    );
    return formatToolResult(res);
  }

  async close(): Promise<void> {
    this.rejectAll(new Error("client closed"));
    await this.transport.close().catch(() => undefined);
    this.status = "closed";
  }

  private handleMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
    if ("id" in msg && msg.id !== undefined) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    }
    // notifications ignored for now (tools/list_changed etc. — future work)
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(req).catch((e: Error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.transport.send({ jsonrpc: "2.0", method, params });
  }
}

function formatToolResult(raw: unknown): string {
  const obj = raw as {
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  };
  const isError = obj?.isError === true;
  const parts: string[] = [];
  for (const block of obj?.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image" && block.mimeType) {
      parts.push(`[image ${block.mimeType}, ${block.data?.length ?? 0} bytes base64]`);
    } else if (block.type === "resource") {
      parts.push(`[resource block]`);
    } else {
      parts.push(`[${block.type} block]`);
    }
  }
  if (parts.length === 0 && obj?.structuredContent !== undefined) {
    parts.push(JSON.stringify(obj.structuredContent));
  }
  const body = parts.join("\n") || "(empty)";
  return isError ? `error: ${body}` : body;
}
