import fs from "node:fs";
import type { MCPConfig, MCPServerConfig } from "./types.js";

/** Load MCP config from a JSON file path. Returns empty config if file missing. */
export async function loadMCPConfig(filePath: string): Promise<MCPConfig> {
  if (!fs.existsSync(filePath)) return { mcpServers: {} };

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
    throw new Error(`Invalid MCP config at ${filePath}: missing "mcpServers" key`);
  }

  const servers: Record<string, MCPServerConfig> = {};
  for (const [name, cfg] of Object.entries(parsed.mcpServers as Record<string, MCPServerConfig>)) {
    servers[name] = applyEnvSubstitution(cfg);
  }

  return { mcpServers: servers };
}

/** Substitute ${VAR_NAME} in all string values of an MCP server config. */
function applyEnvSubstitution(cfg: MCPServerConfig): MCPServerConfig {
  const result: MCPServerConfig = { ...cfg };

  if (result.command) result.command = substituteEnvVars(result.command);
  if (result.url) result.url = substituteEnvVars(result.url);
  if (result.args) result.args = result.args.map(substituteEnvVars);
  if (result.env) {
    result.env = Object.fromEntries(
      Object.entries(result.env).map(([k, v]) => [k, substituteEnvVars(v)]),
    );
  }

  return result;
}

/** Replace ${VAR_NAME} with process.env[VAR_NAME] or empty string. */
export function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    return process.env[name] ?? "";
  });
}

/** Merge global and project MCP configs. Project servers override global by name. */
export function mergeMCPConfigs(
  global: MCPConfig,
  project: MCPConfig | null,
): MCPConfig {
  if (!project) return global;

  return {
    mcpServers: {
      ...global.mcpServers,
      ...project.mcpServers, // project wins on name collision
    },
  };
}
