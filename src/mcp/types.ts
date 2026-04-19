export interface MCPServerConfig {
  /** For stdio-based servers: the command to run */
  command?: string;
  /** Arguments for command-based server */
  args?: string[];
  /** For HTTP/SSE servers: the URL */
  url?: string;
  /** Environment variables (use ${VAR_NAME} for substitution) */
  env?: Record<string, string>;
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface MCPToolDef {
  /** Server that owns this tool */
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
