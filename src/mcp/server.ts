import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJevMcpServer } from "./serverFactory.js";

async function main(): Promise<void> {
  const server = createJevMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("jev-openrouter MCP server fatal error:", err);
  process.exit(1);
});
