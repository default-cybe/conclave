/**
 * Stdio MCP server for hook-engine.test.ts: "many" returns several text
 * blocks, like servers that send one block per record, so the result is a
 * block array instead of one string.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'blocks-server', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'many', description: 'Return several big text blocks.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: ['alpha', 'beta', 'gamma'].map((w) => ({ type: 'text', text: `${w} `.repeat(1500) })),
}));

await server.connect(new StdioServerTransport());
