import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";
import type { ToolDef } from "../tools.js";
import type { Message, Provider, ProviderResponse, ToolCall } from "./types.js";

export class GeminiProvider implements Provider {
  readonly name = "gemini" as const;
  readonly model: string;
  private ai: GoogleGenAI;

  constructor(apiKey: string, model: string) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async chat(messages: Message[], tools: ToolDef[]): Promise<ProviderResponse> {
    const systemParts = messages
      .filter((m): m is Extract<Message, { role: "system" }> => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const contents: Content[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        contents.push({ role: "user", parts: [{ text: m.content }] });
      } else if (m.role === "assistant") {
        const parts: Content["parts"] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.toolCalls ?? []) {
          parts.push({ functionCall: { name: tc.name, args: tc.args } });
        }
        if (parts.length > 0) contents.push({ role: "model", parts });
      } else if (m.role === "tool") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(m.result);
        } catch {
          parsed = { output: m.result };
        }
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: m.name,
                response: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : { output: String(parsed) },
              },
            },
          ],
        });
      }
    }

    const functionDeclarations: FunctionDeclaration[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as FunctionDeclaration["parameters"],
    }));

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents,
      config: {
        systemInstruction: systemParts || undefined,
        tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
      },
    });

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    if (parts.length === 0) {
      const reason = candidate?.finishReason ?? "UNKNOWN";
      const safety = candidate?.safetyRatings ? ` safety=${JSON.stringify(candidate.safetyRatings)}` : "";
      const block = response.promptFeedback?.blockReason ? ` block=${response.promptFeedback.blockReason}` : "";
      throw new Error(`gemini returned empty response (finishReason=${reason}${block}${safety})`);
    }
    let text = "";
    const toolCalls: ToolCall[] = [];
    let idx = 0;
    for (const part of parts) {
      if ("text" in part && typeof part.text === "string") {
        text += part.text;
      } else if ("functionCall" in part && part.functionCall) {
        toolCalls.push({
          id: `gemini_${Date.now()}_${idx++}`,
          name: part.functionCall.name ?? "",
          args: (part.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    }

    return { text, toolCalls };
  }
}
