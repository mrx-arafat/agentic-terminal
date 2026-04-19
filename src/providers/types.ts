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
}

export interface Provider {
  name: "gemini" | "claude" | "openai" | "ollama";
  model: string;
  chat(messages: Message[], tools: ToolDef[]): Promise<ProviderResponse>;
}
