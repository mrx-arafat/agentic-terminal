#!/usr/bin/env node
// Minimal MCP server for tests. Speaks JSON-RPC 2.0 over stdio.
// Advertises two tools: echo(text), fail(msg).

import readline from "node:readline";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: RpcRequest;
  try {
    msg = JSON.parse(line) as RpcRequest;
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notification, ignore

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-server", version: "0.0.1" },
      },
    });
    return;
  }

  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo the input text.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: "fail",
            description: "Always returns an error.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    return;
  }

  if (msg.method === "tools/call") {
    const params = msg.params as { name: string; arguments: Record<string, unknown> };
    if (params.name === "echo") {
      const text = String(params.arguments?.text ?? "");
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `echo:${text}` }] },
      });
      return;
    }
    if (params.name === "fail") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "boom" }], isError: true },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `unknown tool: ${params.name}` },
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32601, message: `unknown method: ${msg.method}` },
  });
});
