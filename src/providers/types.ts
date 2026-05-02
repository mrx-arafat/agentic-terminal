import type { ToolDef } from "../tools.js";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; result: string };

export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ChatOptions {
  /** Abort signal propagated to fetch. */
  signal?: AbortSignal;
}

export interface Provider {
  name: "gemini" | "claude" | "openai" | "ollama" | "claude-cli";
  model: string;
  chat(messages: Message[], tools: ToolDef[], opts?: ChatOptions): Promise<ProviderResponse>;
}
