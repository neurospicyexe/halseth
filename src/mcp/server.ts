import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toReqRes, toFetchResponse } from "fetch-to-node";
import { Env } from "../types.js";
import { registerSessionTools } from "./tools/session.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerCoordinationTools } from "./tools/coordination.js";
import { registerBiometricTools } from "./tools/biometrics.js";
import { registerPersonalityTools } from "./tools/personality.js";
import { registerBridgeTools } from "./tools/bridge.js";

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  // Light auth guard. Skip check if MCP_AUTH_SECRET is not set (local dev).
  if (env.MCP_AUTH_SECRET) {
    const auth = request.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${env.MCP_AUTH_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  // Each request gets a fresh McpServer + transport — stateless by design.
  // All persistent state lives in D1. No in-memory session state between requests.
  const server = new McpServer({
    name: "halseth",
    version: "0.1.0",
  });

  registerSessionTools(server, env);
  registerMemoryTools(server, env);
  registerBiometricTools(server, env);
  registerPersonalityTools(server, env);
  registerBridgeTools(server, env);
  if (env.COORDINATION_ENABLED === "true") {
    registerCoordinationTools(server, env);
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,  // stateless: no Mcp-Session-Id header protocol
  });

  await server.connect(transport);

  const { req, res } = toReqRes(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }

  await transport.handleRequest(req, res, body);

  res.on("close", () => {
    transport.close();
    server.close();
  });

  return toFetchResponse(res);
}
