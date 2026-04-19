import OpenAI from "openai";
import type { ToolDef } from "../tools.js";
import type { Message, Provider, ProviderResponse, ToolCall } from "./types.js";

export class OpenAIProvider implements Provider {
  readonly name = "openai" as const;
  readonly model: string;
  private client: OpenAI;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model;
  }

  async chat(messages: Message[], tools: ToolDef[]): Promise<ProviderResponse> {
    const apiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    for (const m of messages) {
      if (m.role === "system") {
        apiMessages.push({ role: "system", content: m.content });
      } else if (m.role === "user") {
        apiMessages.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: m.content || null,
        };
        if (m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
        }
        apiMessages.push(msg);
      } else if (m.role === "tool") {
        apiMessages.push({
          role: "tool",
          tool_call_id: m.toolCallId,
          content: m.result,
        });
      }
    }

    const apiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    }));

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: apiMessages,
      tools: apiTools.length > 0 ? apiTools : undefined,
    });

    const choice = response.choices[0];
    const text = choice?.message?.content ?? "";
    const toolCalls: ToolCall[] = [];
    for (const tc of choice?.message?.tool_calls ?? []) {
      if (tc.type !== "function") continue;
      let args: Record<string, unknown> = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = { _raw: tc.function.arguments };
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, args });
    }

    return { text: text ?? "", toolCalls };
  }
}
