import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const id = Number(prompt.match(/work on task (\d+)/)[1]);
const client = new Client({ name: 'remote-test-agent', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.TEST_MCP_URL), {
  requestInit: { headers: { authorization: `Bearer ${process.env.SWITCHBOARD_RUN_TOKEN}` } },
}));
const denied = await client.callTool({ name: 'get_task', arguments: { id: id + 10000 } });
if (!denied.isError) throw new Error('Task scope was not enforced');
writeFileSync('switchboard-smoke.txt', `Task ${id} executed in ${process.cwd()}\n`);
await client.callTool({ name: 'add_comment', arguments: { id, body: `Created switchboard-smoke.txt in ${process.cwd()}` } });
await client.callTool({ name: 'finish_task', arguments: { id, summary: 'Remote filesystem and MCP round trip verified' } });
await client.close();
console.log('remote smoke complete');
