import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type ProviderName = "gemini" | "claude" | "openai" | "ollama";

export interface Config {
  provider: ProviderName;
  geminiApiKey?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  ollamaHost?: string;
  geminiModel: string;
  claudeModel: string;
  openaiModel: string;
  ollamaModel: string;
  autoApprove: boolean;
  maxIterations: number;
}

const CONFIG_DIR = path.join(os.homedir(), ".config", "agentic-terminal");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULTS: Config = {
  provider: "gemini",
  geminiModel: "gemini-2.5-flash",
  claudeModel: "claude-sonnet-4-5",
  openaiModel: "gpt-4.1-mini",
  ollamaModel: "qwen2.5:7b",
  ollamaHost: "http://localhost:11434",
  autoApprove: false,
  maxIterations: 25,
};

export function loadConfig(): Config {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function configPath(): string {
  return CONFIG_PATH;
}

export function resolveApiKey(cfg: Config): string | undefined {
  switch (cfg.provider) {
    case "gemini":
      return cfg.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    case "claude":
      return cfg.claudeApiKey || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    case "openai":
      return cfg.openaiApiKey || process.env.OPENAI_API_KEY;
    case "ollama":
      return "not-required";
  }
}

export function resolveModel(cfg: Config): string {
  switch (cfg.provider) {
    case "gemini": return cfg.geminiModel;
    case "claude": return cfg.claudeModel;
    case "openai": return cfg.openaiModel;
    case "ollama": return cfg.ollamaModel;
  }
}

export function setModel(cfg: Config, model: string): void {
  switch (cfg.provider) {
    case "gemini": cfg.geminiModel = model; break;
    case "claude": cfg.claudeModel = model; break;
    case "openai": cfg.openaiModel = model; break;
    case "ollama": cfg.ollamaModel = model; break;
  }
}
