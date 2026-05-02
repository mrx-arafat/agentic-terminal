import type { Config } from "../config.js";
import { resolveApiKey, resolveModel } from "../config.js";
import { ClaudeProvider } from "./claude.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import { GeminiProvider } from "./gemini.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";
import type { Provider } from "./types.js";

export function createProvider(cfg: Config): Provider {
  const model = resolveModel(cfg);
  const apiKey = resolveApiKey(cfg);

  switch (cfg.provider) {
    case "gemini":
      if (!apiKey) throw new Error("Missing GEMINI_API_KEY (set via `agentic setup` or env var)");
      return new GeminiProvider(apiKey, model);
    case "claude":
      if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY (set via `agentic setup` or env var)");
      return new ClaudeProvider(apiKey, model);
    case "openai":
      if (!apiKey) throw new Error("Missing OPENAI_API_KEY (set via `agentic setup` or env var)");
      return new OpenAIProvider(apiKey, model, cfg.openaiBaseUrl);
    case "ollama":
      return new OllamaProvider(model, cfg.ollamaHost);
    case "claude-cli":
      return new ClaudeCliProvider(model, cfg.claudeCliBinary);
  }
}
