/** Runs the `conclave mcp` stdio proxy against $HUB_MCP_URL with $HUB_TOKEN (engine tests). */
import { runStdioProxy } from '../../../src/engine/hub-mcp';

await runStdioProxy({ url: process.env.HUB_MCP_URL!, token: process.env.HUB_TOKEN });
