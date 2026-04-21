import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCPClient } from "../../src/mcp/client.js";
import { MCPManager, qualifyName } from "../../src/mcp/manager.js";
import type { MCPServerConfig } from "../../src/mcp/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(here, "mock-server.ts");

function mockCfg(): MCPServerConfig {
  return { command: "npx", args: ["tsx", MOCK] };
}

describe("MCPClient (stdio)", () => {
  let client: MCPClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
  });

  it("connects, initializes, lists tools", async () => {
    client = new MCPClient("mock", mockCfg());
    await client.connect();
    expect(client.status).toBe("ready");
    const tools = client.getTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["echo", "fail"]);
    expect(tools[0].server).toBe("mock");
  }, 15_000);

  it("calls a tool and receives text content", async () => {
    client = new MCPClient("mock", mockCfg());
    await client.connect();
    const result = await client.callTool("echo", { text: "hi" });
    expect(result).toBe("echo:hi");
  }, 15_000);

  it("formats tool errors with error: prefix", async () => {
    client = new MCPClient("mock", mockCfg());
    await client.connect();
    const result = await client.callTool("fail", {});
    expect(result.startsWith("error:")).toBe(true);
    expect(result).toContain("boom");
  }, 15_000);

  it("rejects HTTP/SSE transport (not yet supported)", () => {
    expect(() => new MCPClient("x", { url: "http://example.com" })).toThrow(/HTTP\/SSE/);
  });
});

describe("MCPManager", () => {
  let mgr: MCPManager | null = null;

  afterEach(async () => {
    if (mgr) {
      await mgr.disconnectAll();
      mgr = null;
    }
  });

  it("qualifies tool names with mcp__server__tool prefix", () => {
    expect(qualifyName("fs", "read_file")).toBe("mcp__fs__read_file");
  });

  it("sanitizes chars not allowed by Anthropic tool name regex", () => {
    // dots not allowed → become underscores
    expect(qualifyName("my.server", "do.it")).toBe("mcp__my_server__do_it");
  });

  it("connects configured server and exposes prefixed ToolDefs", async () => {
    mgr = new MCPManager();
    // inject config directly via reflection-ish cast (no file I/O in test)
    (mgr as unknown as { servers: Record<string, MCPServerConfig> }).servers = {
      mock: mockCfg(),
    };
    await mgr.connectAll();
    const defs = mgr.getToolDefs();
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(["mcp__mock__echo", "mcp__mock__fail"]);
    expect(defs.every((d) => d.dangerous === true)).toBe(true);
    expect(mgr.owns("mcp__mock__echo")).toBe(true);
    expect(mgr.owns("read_file")).toBe(false);
  }, 15_000);

  it("routes callTool through the right client", async () => {
    mgr = new MCPManager();
    (mgr as unknown as { servers: Record<string, MCPServerConfig> }).servers = {
      mock: mockCfg(),
    };
    await mgr.connectAll();
    const out = await mgr.callTool("mcp__mock__echo", { text: "abc" });
    expect(out).toBe("echo:abc");
  }, 15_000);

  it("returns error: for unknown qualified name", async () => {
    mgr = new MCPManager();
    const out = await mgr.callTool("mcp__nope__thing", {});
    expect(out.startsWith("error:")).toBe(true);
  });

  it("reports status for configured but not-yet-connected servers", async () => {
    mgr = new MCPManager();
    (mgr as unknown as { servers: Record<string, MCPServerConfig> }).servers = {
      mock: mockCfg(),
    };
    const before = mgr.status();
    expect(before).toEqual([{ name: "mock", status: "idle", toolCount: 0, error: undefined }]);
  });
});
