import { spawn } from "node:child_process";
import type { ToolDef } from "../tools.js";
import type { ChatOptions, Message, Provider, ProviderResponse, ToolCall } from "./types.js";

interface ClaudeCliResult {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export class ClaudeCliProvider implements Provider {
  readonly name = "claude-cli" as const;
  readonly model: string;
  private binary: string;

  constructor(model: string, binary = "claude") {
    this.model = model;
    this.binary = binary;
  }

  async chat(messages: Message[], tools: ToolDef[], opts?: ChatOptions): Promise<ProviderResponse> {
    const { system, prompt } = this.buildPrompt(messages, tools);

    const args = [
      "--print",
      "--output-format=json",
      "--model", this.model,
      "--tools", "",
      "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}',
      "--exclude-dynamic-system-prompt-sections",
    ];
    if (system) args.push("--append-system-prompt", system);

    const stdout = await this.runCli(args, prompt, opts?.signal);
    const parsed = this.parseResult(stdout);

    if (parsed.is_error) {
      throw new Error(`Claude CLI error: ${parsed.result ?? "unknown"}`);
    }

    const text = parsed.result ?? "";
    const { cleaned, toolCalls } = extractToolCalls(text);

    return {
      text: cleaned,
      toolCalls,
      usage: parsed.usage
        ? {
            inputTokens: parsed.usage.input_tokens ?? 0,
            outputTokens: parsed.usage.output_tokens ?? 0,
          }
        : undefined,
    };
  }

  private buildPrompt(messages: Message[], tools: ToolDef[]): { system: string; prompt: string } {
    const systemParts: string[] = [];
    for (const m of messages) {
      if (m.role === "system") systemParts.push(m.content);
    }

    if (tools.length > 0) {
      systemParts.push(buildToolInstructions(tools));
    }

    const transcript: string[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        transcript.push(`User: ${m.content}`);
      } else if (m.role === "assistant") {
        const parts: string[] = [];
        if (m.content) parts.push(m.content);
        for (const tc of m.toolCalls ?? []) {
          parts.push(`<tool_call>${JSON.stringify({ name: tc.name, args: tc.args })}</tool_call>`);
        }
        if (parts.length > 0) transcript.push(`Assistant: ${parts.join("\n")}`);
      } else if (m.role === "tool") {
        transcript.push(`<tool_result name="${m.name}" id="${m.toolCallId}">\n${m.result}\n</tool_result>`);
      }
    }

    return { system: systemParts.join("\n\n"), prompt: transcript.join("\n\n") };
  }

  private runCli(args: string[], stdin: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, 180_000);

      const onAbort = (): void => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });

      child.on("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(`Claude CLI binary not found at "${this.binary}". Install Claude Code: https://docs.claude.com/en/docs/claude-code`));
        } else {
          reject(err);
        }
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (code !== 0) {
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
          return;
        }
        resolve(stdout);
      });

      child.stdin.end(stdin);
    });
  }

  private parseResult(stdout: string): ClaudeCliResult {
    const trimmed = stdout.trim();
    if (!trimmed) return { type: "result", is_error: true, result: "empty stdout" };
    try {
      return JSON.parse(trimmed) as ClaudeCliResult;
    } catch {
      const lastBrace = trimmed.lastIndexOf("{");
      if (lastBrace >= 0) {
        try { return JSON.parse(trimmed.slice(lastBrace)) as ClaudeCliResult; } catch { /* fallthrough */ }
      }
      return { type: "result", result: trimmed };
    }
  }
}

function buildToolInstructions(tools: ToolDef[]): string {
  const lines: string[] = [];
  lines.push("# Tool Use Protocol");
  lines.push("");
  lines.push("CRITICAL RULES:");
  lines.push("1. If you need a tool, output ONLY the tool_call tag. NO preamble, NO explanation, NO guesses about the result.");
  lines.push("2. NEVER write 'Let me check...', 'I'll run...', 'Done.', or describe what you're about to do. Just emit the tool_call.");
  lines.push("3. NEVER fabricate tool_result blocks. NEVER predict what a tool will return. The system supplies real results.");
  lines.push("4. ONE tool per turn. Wait for the real result before continuing.");
  lines.push("5. After receiving a real tool result, give a concise final answer based ONLY on that result.");
  lines.push("6. Use ONLY the <tool_call> format below. DO NOT use <function_calls>, <function_call>, <invoke>, JSON arrays, or any other format.");
  lines.push("7. NEVER write XML-like tags such as <result>, <output>, <thinking>, <stdout>, <stderr>, <exit_code> — those are forbidden in your output.");
  lines.push("8. NEVER claim success or summarize results without reading the real tool result. If a tool failed, acknowledge the failure honestly.");
  lines.push("9. To overwrite an existing file, the workflow is: read_file → edit_file. write_file errors on existing paths.");
  lines.push("");
  lines.push("EXACT format (one tool call, JSON object inside):");
  lines.push('<tool_call>{"name":"tool_name","args":{"param":"value"}}</tool_call>');
  lines.push("");
  lines.push("WRONG (do not use these):");
  lines.push('  <function_calls>[{"name":"x","args":{}}]</function_calls>');
  lines.push('  <function_call>{"name":"x"}</function_call>');
  lines.push('  <invoke name="x">...</invoke>');
  lines.push("");
  lines.push("If no tool is needed, reply with plain text only.");
  lines.push("");
  lines.push("# Available Tools");
  lines.push("");
  for (const t of tools) {
    lines.push(`## ${t.name}`);
    lines.push(t.description);
    lines.push("Parameters (JSON Schema):");
    lines.push("```json");
    lines.push(JSON.stringify(t.parameters, null, 2));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

function extractToolCalls(text: string): { cleaned: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  let cleaned = text;
  let idx = 0;

  const push = (name?: string, args?: Record<string, unknown>): void => {
    if (!name) return;
    toolCalls.push({
      id: `claude_cli_${Date.now()}_${idx++}`,
      name,
      args: args ?? {},
    });
  };

  // Format 1: <tool_call>{...}</tool_call>
  const reSingle = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = reSingle.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]) as { name?: string; args?: Record<string, unknown> };
      push(obj.name, obj.args);
    } catch { /* skip */ }
  }
  cleaned = cleaned.replace(reSingle, "");

  // Format 2: <function_calls>[{...},{...}]</function_calls> or single object
  const reFn = /<function_calls>\s*([\s\S]*?)\s*<\/function_calls>/g;
  while ((m = reFn.exec(text)) !== null) {
    const body = m[1].trim();
    try {
      const parsed = JSON.parse(body) as
        | { name?: string; args?: Record<string, unknown>; parameters?: Record<string, unknown> }
        | Array<{ name?: string; args?: Record<string, unknown>; parameters?: Record<string, unknown> }>;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) push(item.name, item.args ?? item.parameters);
    } catch { /* skip */ }
  }
  cleaned = cleaned.replace(reFn, "");

  // Format 3: <function_call> ... </function_call> (singular)
  const reFnSingle = /<function_call>\s*(\{[\s\S]*?\})\s*<\/function_call>/g;
  while ((m = reFnSingle.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]) as { name?: string; args?: Record<string, unknown>; parameters?: Record<string, unknown> };
      push(obj.name, obj.args ?? obj.parameters);
    } catch { /* skip */ }
  }
  cleaned = cleaned.replace(reFnSingle, "");

  // Format 4: <invoke name="x"><parameter name="p">v</parameter></invoke>
  const reInvoke = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  while ((m = reInvoke.exec(text)) !== null) {
    const name = m[1];
    const body = m[2];
    const args: Record<string, unknown> = {};
    const reParam = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = reParam.exec(body)) !== null) {
      const v = pm[2].trim();
      try { args[pm[1]] = JSON.parse(v); } catch { args[pm[1]] = v; }
    }
    push(name, args);
  }
  cleaned = cleaned.replace(reInvoke, "");

  // Format 5: Bare JSON arrays/objects with name+args (no wrapping tags).
  // Scan all balanced { } and [ ] regions for tool-call shape.
  cleaned = stripBareJsonToolCalls(cleaned, push);

  // Strip hallucinated wrapped blocks (tool_result / result / thinking / etc.)
  cleaned = cleaned.replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/g, "");
  cleaned = cleaned.replace(/<result[^>]*>[\s\S]*?<\/result>/g, "");
  cleaned = cleaned.replace(/<thinking[^>]*>[\s\S]*?<\/thinking>/g, "");
  cleaned = cleaned.replace(/<output[^>]*>[\s\S]*?<\/output>/g, "");
  // Strip any remaining lone tags (open or close, partial allowed)
  cleaned = cleaned.replace(/<\/?(tool_call|tool_result|function_call|function_calls|invoke|parameter|parameters|result|thinking|output|stdout|stderr|exit_code)\b[^>]*>/g, "");

  // Drop any preamble/interleaved text when the model emitted tool calls.
  // Final answers come after the real tool result is fed back, on the next turn.
  if (toolCalls.length > 0) {
    cleaned = "";
  }
  return { cleaned: cleaned.trim(), toolCalls };
}

type PushFn = (name?: string, args?: Record<string, unknown>) => void;

/** Find balanced JSON arrays/objects looking like tool calls; extract + strip. */
function stripBareJsonToolCalls(text: string, push: PushFn): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const end = findBalancedJson(text, i);
      if (end > i) {
        const candidate = text.slice(i, end + 1);
        const parsed = tryParseToolCall(candidate);
        if (parsed) {
          for (const c of parsed) push(c.name, c.args ?? c.parameters);
          i = end + 1;
          // Also drop a single trailing newline so we don't leave a blank line
          if (text[i] === "\n") i++;
          continue;
        }
      }
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

/** Walk from `start` (a `{` or `[`) to its matching close, respecting strings. */
function findBalancedJson(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") { escape = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface ToolCallShape { name?: string; args?: Record<string, unknown>; parameters?: Record<string, unknown> }

function tryParseToolCall(s: string): ToolCallShape[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(s); } catch { return null; }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: ToolCallShape[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") return null;
    const obj = item as ToolCallShape;
    if (typeof obj.name !== "string") return null;
    if (obj.args !== undefined && (typeof obj.args !== "object" || Array.isArray(obj.args))) return null;
    if (obj.parameters !== undefined && (typeof obj.parameters !== "object" || Array.isArray(obj.parameters))) return null;
    out.push(obj);
  }
  return out.length > 0 ? out : null;
}
