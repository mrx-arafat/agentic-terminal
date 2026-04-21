import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDef } from "../tools.js";
import { MCPClient } from "./client.js";
import { loadMCPConfig, mergeMCPConfigs } from "./config-loader.js";
import type { MCPConfig, MCPServerConfig, MCPToolDef } from "./types.js";

const TOOL_PREFIX = "mcp__";
const MAX_TOOL_NAME = 64;

export interface ServerStatus {
  name: string;
  status: "ready" | "connecting" | "error" | "closed" | "idle";
  toolCount: number;
  error?: string;
}

export class MCPManager {
  private clients = new Map<string, MCPClient>();
  private servers: Record<string, MCPServerConfig> = {};
  /** qualifiedName (mcp__server__tool) -> { server, toolName } */
  private toolIndex = new Map<string, { server: string; toolName: string }>();

  async loadConfigs(cwd: string): Promise<void> {
    const globalPath = path.join(os.homedir(), ".config", "agentic-terminal", "mcp.json");
    const projectPath = path.join(cwd, ".agentic", "mcp.json");
    let global: MCPConfig = { mcpServers: {} };
    let project: MCPConfig = { mcpServers: {} };
    try { global = await loadMCPConfig(globalPath); } catch { /* tolerate missing */ }
    try { project = await loadMCPConfig(projectPath); } catch { /* tolerate missing */ }
    const merged = mergeMCPConfigs(global, project);
    this.servers = merged.mcpServers;
  }

  listConfigured(): string[] {
    return Object.keys(this.servers);
  }

  async connectAll(onWarn?: (msg: string) => void): Promise<void> {
    const names = Object.keys(this.servers);
    await Promise.all(names.map((n) => this.connect(n).catch((e: Error) => {
      onWarn?.(`mcp '${n}' failed: ${e.message}`);
    })));
    this.rebuildIndex();
  }

  async connect(name: string): Promise<MCPClient> {
    const existing = this.clients.get(name);
    if (existing && existing.status === "ready") return existing;
    const cfg = this.servers[name];
    if (!cfg) throw new Error(`no MCP server named '${name}' in config`);
    const client = new MCPClient(name, cfg);
    this.clients.set(name, client);
    await client.connect();
    this.rebuildIndex();
    return client;
  }

  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) return;
    await client.close();
    this.clients.delete(name);
    this.rebuildIndex();
  }

  async disconnectAll(): Promise<void> {
    const closes = Array.from(this.clients.values()).map((c) => c.close().catch(() => undefined));
    await Promise.all(closes);
    this.clients.clear();
    this.rebuildIndex();
  }

  status(): ServerStatus[] {
    const out: ServerStatus[] = [];
    for (const name of Object.keys(this.servers)) {
      const c = this.clients.get(name);
      out.push({
        name,
        status: c?.status ?? "idle",
        toolCount: c?.getTools().length ?? 0,
        error: c?.lastError,
      });
    }
    return out;
  }

  getAllTools(): MCPToolDef[] {
    const out: MCPToolDef[] = [];
    for (const c of this.clients.values()) {
      if (c.status !== "ready") continue;
      out.push(...c.getTools());
    }
    return out;
  }

  /** Tool defs formatted for the LLM (with mcp__server__tool prefix). */
  getToolDefs(): ToolDef[] {
    return this.getAllTools().map((t) => ({
      name: qualifyName(t.server, t.name),
      description: `[mcp:${t.server}] ${t.description}`.slice(0, 1024),
      parameters: normalizeSchema(t.inputSchema),
      dangerous: true, // MCP tools run external code — treat as dangerous
    }));
  }

  /** True iff this tool name is one of our MCP-qualified names. */
  owns(toolName: string): boolean {
    return this.toolIndex.has(toolName);
  }

  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.toolIndex.get(qualifiedName);
    if (!entry) return `error: no MCP tool named '${qualifiedName}'`;
    const client = this.clients.get(entry.server);
    if (!client) return `error: MCP server '${entry.server}' not connected`;
    if (client.status !== "ready") return `error: MCP server '${entry.server}' status=${client.status}`;
    try {
      return await client.callTool(entry.toolName, args);
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  }

  private rebuildIndex(): void {
    this.toolIndex.clear();
    for (const c of this.clients.values()) {
      if (c.status !== "ready") continue;
      for (const t of c.getTools()) {
        this.toolIndex.set(qualifyName(c.name, t.name), { server: c.name, toolName: t.name });
      }
    }
  }
}

export function qualifyName(server: string, tool: string): string {
  const safeServer = sanitize(server);
  const safeTool = sanitize(tool);
  const full = `${TOOL_PREFIX}${safeServer}__${safeTool}`;
  return full.length <= MAX_TOOL_NAME ? full : full.slice(0, MAX_TOOL_NAME);
}

function sanitize(s: string): string {
  // Anthropic tool names allow [a-zA-Z0-9_-]{1,64}
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  // Ensure a valid object schema — Claude requires type: "object" at root.
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const out = { ...schema };
  if (out.type === undefined) out.type = "object";
  if (out.type === "object" && out.properties === undefined) out.properties = {};
  return out;
}

/** Utility: check whether any project/global MCP config file exists. */
export function hasAnyMCPConfig(cwd: string): boolean {
  const globalPath = path.join(os.homedir(), ".config", "agentic-terminal", "mcp.json");
  const projectPath = path.join(cwd, ".agentic", "mcp.json");
  return fs.existsSync(globalPath) || fs.existsSync(projectPath);
}
