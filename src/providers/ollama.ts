import type { ToolDef } from "../tools.js";
import type { ChatOptions, Message, Provider, ProviderResponse, ToolCall } from "./types.js";

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

interface OllamaChatResponse {
  message?: {
    role: string;
    content?: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> };
    }>;
  };
  done?: boolean;
  error?: string;
}

export class OllamaProvider implements Provider {
  readonly name = "ollama" as const;
  readonly model: string;
  private host: string;

  constructor(model: string, host = "http://localhost:11434") {
    this.model = model;
    this.host = host.replace(/\/+$/, "");
  }

  async chat(messages: Message[], tools: ToolDef[], opts?: ChatOptions): Promise<ProviderResponse> {
    const apiMessages: OllamaMessage[] = [];
    for (const m of messages) {
      if (m.role === "system") {
        apiMessages.push({ role: "system", content: m.content });
      } else if (m.role === "user") {
        apiMessages.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        const msg: OllamaMessage = { role: "assistant", content: m.content || "" };
        if (m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            function: { name: tc.name, arguments: tc.args },
          }));
        }
        apiMessages.push(msg);
      } else if (m.role === "tool") {
        apiMessages.push({ role: "tool", content: m.result });
      }
    }

    const apiTools = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const body = {
      model: this.model,
      messages: apiMessages,
      stream: false,
      tools: apiTools.length > 0 ? apiTools : undefined,
    };

    // Cap tool-message content to keep the 7B-model context window happy.
    // Local `blocks` and tool results are unaffected; this only clips what
    // goes into the chat prompt.
    const MAX_TOOL_CHARS = 6000;
    for (const m of apiMessages) {
      if (m.role === "tool" && m.content.length > MAX_TOOL_CHARS) {
        m.content = m.content.slice(0, MAX_TOOL_CHARS) + `\n[… truncated ${m.content.length - MAX_TOOL_CHARS} chars]`;
      }
    }

    // Timeout = 3 min by default; aborted by caller on Ctrl+C.
    const timeout = setTimeout(() => controllerInternal.abort(), 180_000);
    const controllerInternal = new AbortController();
    const signal = opts?.signal
      ? anySignal([opts.signal, controllerInternal.signal])
      : controllerInternal.signal;

    let res: Response;
    try {
      res = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      const err = e as Error;
      if (err.name === "AbortError") {
        throw new Error("Ollama request timed out or was cancelled (no response in 3 min). The model may be overloaded; try a smaller context, a fresh /clear, or a stronger model.");
      }
      throw err;
    }
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    if (data.error) throw new Error(`Ollama error: ${data.error}`);

    const text = data.message?.content ?? "";
    const toolCalls: ToolCall[] = [];
    let idx = 0;
    for (const tc of data.message?.tool_calls ?? []) {
      toolCalls.push({
        id: `ollama_${Date.now()}_${idx++}`,
        name: tc.function.name,
        args: tc.function.arguments ?? {},
      });
    }

    return { text, toolCalls };
  }
}

/** Combine multiple AbortSignals into one. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) { controller.abort(s.reason); break; }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
