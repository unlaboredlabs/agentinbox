import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { router } from "../api/util.ts";
import type { AppContext } from "../context.ts";
import { buildMcpServer } from "./server.ts";

const bearer = (header: string | undefined): string | null => {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m ? m[1]! : null;
};

/** Streamable HTTP MCP endpoint (stateless: one server + transport per request). Mounted at the root. */
export function mcpRoutes(ctx: AppContext) {
  const app = router();

  app.all("/mcp", async (c) => {
    const key = bearer(c.req.header("authorization"));
    const principal = key ? ctx.policy.authenticate(key) : null;
    if (!principal) {
      c.header("WWW-Authenticate", 'Bearer realm="agentinbox"');
      return c.json(
        {
          error: {
            code: "unauthorized",
            message: key ? "Invalid or disabled agent API key." : "Missing agent API key.",
            hint: "Send the agent's key as `Authorization: Bearer aib_…`. Keys are created in the agentinbox console under Agents.",
          },
        },
        401,
      );
    }
    c.set("agent", principal);

    if (c.req.method !== "POST") {
      c.header("Allow", "POST");
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless; use POST." }, id: null }, 405);
    }

    const server = buildMcpServer(ctx, principal, { signal: c.req.raw.signal });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });

  return app;
}
