/** Stdio MCP server for tests: one tool that reports its argv, cwd and a few env names. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'env-server', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'env', description: 'Report argv, cwd and env.', inputSchema: { type: 'object', properties: {} } }] }));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env).sort(), own: process.env.OWN_VALUE ?? null }) }],
}));
await server.connect(new StdioServerTransport());
