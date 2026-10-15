// MCP client as a real agent would run it: the SDK Client over streamable HTTP with a bearer key.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resilientFetch } from "./fetch.ts";

export interface ToolResult {
  text: string;
  isError: boolean;
  raw: Awaited<ReturnType<Client["callTool"]>>;
}

export interface Agent {
  client: Client;
  tools(): Promise<string[]>;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** call() that throws when the tool returns isError. */
  ok(name: string, args?: Record<string, unknown>): Promise<string>;
  /** call() + JSON.parse of the text (send tools return JSON). */
  json<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export async function connectAgent(baseUrl: string, apiKey: string, name = "e2e-agent"): Promise<Agent> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
      fetch: resilientFetch,
    }),
  );
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const raw = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 70_000 });
    const content = (raw.content ?? []) as { type: string; text?: string }[];
    return { raw, isError: raw.isError === true, text: content.map((c) => c.text ?? "").join("\n") };
  };
  return {
    client,
    async tools() {
      return (await client.listTools()).tools.map((t) => t.name).sort();
    },
    call,
    async ok(tool, args) {
      const r = await call(tool, args);
      if (r.isError) throw new Error(`${tool} failed: ${r.text}`);
      return r.text;
    },
    async json(tool, args) {
      const r = await call(tool, args);
      if (r.isError) throw new Error(`${tool} failed: ${r.text}`);
      return JSON.parse(r.text);
    },
    close: () => client.close(),
  };
}
