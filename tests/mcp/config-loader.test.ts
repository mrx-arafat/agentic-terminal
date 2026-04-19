import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadMCPConfig, mergeMCPConfigs, substituteEnvVars } from "../../src/mcp/config-loader.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-mcp-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeMCP(dir: string, config: object): string {
  const p = path.join(dir, "mcp.json");
  fs.writeFileSync(p, JSON.stringify(config));
  return p;
}

describe("loadMCPConfig", () => {
  it("returns empty config when file does not exist", async () => {
    const config = await loadMCPConfig("/nonexistent/mcp.json");
    expect(config.mcpServers).toEqual({});
  });

  it("loads command-based server", async () => {
    const p = writeMCP(tmpDir, {
      mcpServers: {
        github: { command: "npx", args: ["-y", "@mcp/github"] },
      },
    });
    const config = await loadMCPConfig(p);
    expect(config.mcpServers.github.command).toBe("npx");
    expect(config.mcpServers.github.args).toEqual(["-y", "@mcp/github"]);
  });

  it("loads URL-based server", async () => {
    const p = writeMCP(tmpDir, {
      mcpServers: {
        mydb: { url: "http://localhost:5432/mcp" },
      },
    });
    const config = await loadMCPConfig(p);
    expect(config.mcpServers.mydb.url).toBe("http://localhost:5432/mcp");
  });

  it("throws on invalid JSON", async () => {
    const p = path.join(tmpDir, "mcp.json");
    fs.writeFileSync(p, "not json {{");
    await expect(loadMCPConfig(p)).rejects.toThrow();
  });

  it("throws when mcpServers key is missing", async () => {
    const p = writeMCP(tmpDir, { servers: {} });
    await expect(loadMCPConfig(p)).rejects.toThrow("mcpServers");
  });
});

describe("substituteEnvVars", () => {
  it("substitutes ${VAR} with env value", () => {
    process.env["TEST_TOKEN_XYZ"] = "secret-value";
    const result = substituteEnvVars("Bearer ${TEST_TOKEN_XYZ}");
    expect(result).toBe("Bearer secret-value");
    delete process.env["TEST_TOKEN_XYZ"];
  });

  it("leaves unset vars as empty string", () => {
    const result = substituteEnvVars("${DEFINITELY_NOT_SET_VAR_12345}");
    expect(result).toBe("");
  });

  it("handles string without vars unchanged", () => {
    const result = substituteEnvVars("plain value");
    expect(result).toBe("plain value");
  });

  it("substitutes all vars in env block", () => {
    process.env["A_KEY"] = "aaa";
    process.env["B_KEY"] = "bbb";
    const result = substituteEnvVars("${A_KEY}:${B_KEY}");
    expect(result).toBe("aaa:bbb");
    delete process.env["A_KEY"];
    delete process.env["B_KEY"];
  });
});

describe("mergeMCPConfigs", () => {
  it("returns global config when no project config", () => {
    const global = { mcpServers: { github: { command: "npx", args: [] } } };
    const merged = mergeMCPConfigs(global, null);
    expect(merged.mcpServers.github).toBeDefined();
  });

  it("project config overrides global by server name", () => {
    const global = {
      mcpServers: { github: { command: "npx-global", args: [] } },
    };
    const project = {
      mcpServers: { github: { command: "npx-project", args: [] } },
    };
    const merged = mergeMCPConfigs(global, project);
    expect(merged.mcpServers.github.command).toBe("npx-project");
  });

  it("includes servers from both global and project", () => {
    const global = { mcpServers: { github: { command: "npx", args: [] } } };
    const project = { mcpServers: { postgres: { url: "http://localhost/mcp" } } };
    const merged = mergeMCPConfigs(global, project);
    expect(Object.keys(merged.mcpServers)).toHaveLength(2);
  });
});
