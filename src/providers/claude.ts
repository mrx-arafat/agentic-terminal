import Anthropic from "@anthropic-ai/sdk";
import type { ToolDef } from "../tools.js";
import type { Message, Provider, ProviderResponse, ToolCall } from "./types.js";

export class ClaudeProvider implements Provider {
  readonly name = "claude" as const;
  readonly model: string;
  private client: Anthropic;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(messages: Message[], tools: ToolDef[]): Promise<ProviderResponse> {
    const system = messages
      .filter((m): m is Extract<Message, { role: "system" }> => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const apiMessages: Anthropic.MessageParam[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        apiMessages.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls ?? []) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
        }
        if (blocks.length > 0) apiMessages.push({ role: "assistant", content: blocks });
      } else if (m.role === "tool") {
        apiMessages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.result }],
        });
      }
    }

    const apiTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: system || undefined,
      tools: apiTools.length > 0 ? apiTools : undefined,
      messages: apiMessages,
    });

    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
