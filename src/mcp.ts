import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import type { Store } from './store.js';
import type { EventBus } from './events.js';
import { toolHandlers, ToolError, type ToolOptions } from './tools.js';
import { AGENT_IDS, type Author } from './types.js';

const statusSchema = z.enum(['inbox', 'ready', 'in_progress', 'review', 'needs_human', 'done']);
const authorSchema = z.enum([...AGENT_IDS, 'human'] as const);

/**
 * Stateless streamable-HTTP MCP endpoint: a fresh server+transport per request.
 * Identity (`actor`) is derived from the connection (URL path), never from tool args.
 */
export async function handleMcpRequest(
  store: Store,
  bus: EventBus,
  actor: Author,
  req: Request,
  res: Response,
  options: ToolOptions = {},
): Promise<void> {
  const server = new McpServer({ name: 'switchboard', version: '0.1.0' });
  const h = toolHandlers(store, bus, actor, options);

  const wrap = (fn: (args: never) => unknown) => (args: unknown) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(fn(args as never), null, 2) }] };
    } catch (e) {
      const message = e instanceof ToolError ? e.message : `Internal error: ${String(e)}`;
      return { content: [{ type: 'text' as const, text: message }], isError: true };
    }
  };

  server.registerTool('list_tasks', {
    description: 'List tasks on the shared board, optionally filtered by project name, status, or assignee.',
    inputSchema: { project: z.string().optional(), status: statusSchema.optional(), assignee: authorSchema.optional() },
  }, wrap(h.list_tasks));

  server.registerTool('get_task', {
    description: 'Get one task with its full comment thread and run history.',
    inputSchema: { id: z.number() },
  }, wrap(h.get_task));

  server.registerTool('create_task', {
    description: 'Create a task. Assigning it to an agent (claude, codex, nyx, gemini, deepseek) queues it for automatic dispatch; "human" parks it in the inbox. Optional model/effort override which brain runs the task (claude effort: off|low|medium|high|xhigh|max; codex effort: minimal|low|medium|high|xhigh; gemini effort: low|medium|high).',
    inputSchema: {
      project: z.string(), title: z.string(), description: z.string().optional(), assignee: authorSchema,
      model: z.string().optional(), effort: z.string().optional(),
      draft: z.boolean().optional().describe('true = park in the inbox for human review instead of dispatching; the assignee is kept for later release'),
      worker_id: z.string().optional().describe('Named remote PC worker (must be a configured worker id; only claude or codex can run remotely); omit to execute on the board host'),
      depends_on: z.array(z.number()).optional().describe('ids of tasks that must reach review/done before this one dispatches; declare true dependencies only — independent tasks may run in parallel'),
    },
  }, wrap(h.create_task));

  server.registerTool('claim_task', {
    description: 'Claim a task for yourself and mark it in_progress.',
    inputSchema: { id: z.number() },
  }, wrap(h.claim_task));

  server.registerTool('add_comment', {
    description: 'Post a comment on a task. Authorship is your connection identity.',
    inputSchema: { id: z.number(), body: z.string() },
  }, wrap(h.add_comment));

  server.registerTool('assign_task', {
    description: 'Hand a task to an agent (claude, codex, nyx, gemini, deepseek — re-queues it for dispatch) or to "human" (needs_human).',
    inputSchema: { id: z.number(), assignee: authorSchema },
  }, wrap(h.assign_task));

  server.registerTool('update_status', {
    description: 'Set task status: inbox, ready, in_progress, review, needs_human, or done. Setting "ready" re-queues for dispatch.',
    inputSchema: { id: z.number(), status: statusSchema },
  }, wrap(h.update_status));

  server.registerTool('finish_task', {
    description: 'Mark a task finished: posts your summary comment and moves it to review.',
    inputSchema: { id: z.number(), summary: z.string() },
  }, wrap(h.finish_task));

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
