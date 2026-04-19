import type { ProviderName } from "./config.js";

export type Tier = "small" | "medium" | "large" | "flagship" | "reasoning";

export interface ModelInfo {
  id: string;
  label: string;
  tier: Tier;
  notes?: string;
}

export const MODEL_CATALOG: Record<ProviderName, ModelInfo[]> = {
  gemini: [
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", tier: "small", notes: "Cheapest, fastest" },
    { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite", tier: "small" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "medium", notes: "Balanced default" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", tier: "medium" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", tier: "large", notes: "Flagship reasoning" },
  ],
  claude: [
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", tier: "small", notes: "Fast + cheap" },
    { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku", tier: "small" },
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", tier: "medium", notes: "Balanced" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "medium", notes: "Coding default" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", tier: "flagship", notes: "Strongest Claude" },
  ],
  openai: [
    { id: "gpt-4.1-nano", label: "GPT-4.1 Nano", tier: "small", notes: "Cheapest" },
    { id: "gpt-4o-mini", label: "GPT-4o Mini", tier: "small" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 Mini", tier: "small" },
    { id: "gpt-4o", label: "GPT-4o", tier: "medium" },
    { id: "gpt-4.1", label: "GPT-4.1", tier: "medium", notes: "Balanced" },
    { id: "gpt-5-mini", label: "GPT-5 Mini", tier: "large" },
    { id: "gpt-5", label: "GPT-5", tier: "flagship", notes: "Flagship" },
    { id: "o4-mini", label: "o4-mini", tier: "reasoning", notes: "Reasoning, cheap" },
    { id: "o3", label: "o3", tier: "reasoning", notes: "Reasoning, strong" },
  ],
  ollama: [
    { id: "llama3.2:1b", label: "Llama 3.2 1B", tier: "small", notes: "Tiny" },
    { id: "llama3.2:3b", label: "Llama 3.2 3B", tier: "small" },
    { id: "qwen2.5:3b", label: "Qwen 2.5 3B", tier: "small", notes: "Tool-capable" },
    { id: "phi4-mini", label: "Phi-4 Mini", tier: "small" },
    { id: "gemma3:4b", label: "Gemma 3 4B", tier: "small" },
    { id: "qwen2.5:7b", label: "Qwen 2.5 7B", tier: "medium", notes: "Tool-capable, recommended" },
    { id: "llama3.1:8b", label: "Llama 3.1 8B", tier: "medium", notes: "Tool-capable" },
    { id: "mistral:7b", label: "Mistral 7B", tier: "medium" },
    { id: "qwen2.5:14b", label: "Qwen 2.5 14B", tier: "large", notes: "Tool-capable" },
    { id: "qwen2.5:32b", label: "Qwen 2.5 32B", tier: "large" },
    { id: "mixtral:8x7b", label: "Mixtral 8x7B", tier: "large" },
    { id: "qwen2.5:72b", label: "Qwen 2.5 72B", tier: "flagship", notes: "Best local tool-use" },
    { id: "llama3.3:70b", label: "Llama 3.3 70B", tier: "flagship", notes: "Tool-capable" },
    { id: "deepseek-r1:70b", label: "DeepSeek R1 70B", tier: "reasoning", notes: "Local reasoning" },
    { id: "deepseek-r1:32b", label: "DeepSeek R1 32B", tier: "reasoning" },
  ],
};

export function groupByTier(provider: ProviderName): Record<Tier, ModelInfo[]> {
  const out: Record<Tier, ModelInfo[]> = {
    small: [],
    medium: [],
    large: [],
    flagship: [],
    reasoning: [],
  };
  for (const m of MODEL_CATALOG[provider]) out[m.tier].push(m);
  return out;
}

export const TIER_ORDER: Tier[] = ["small", "medium", "large", "flagship", "reasoning"];

export const TIER_LABEL: Record<Tier, string> = {
  small: "Small / Fast",
  medium: "Medium / Balanced",
  large: "Large / Strong",
  flagship: "Flagship",
  reasoning: "Reasoning",
};
