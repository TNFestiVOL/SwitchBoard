import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { EventBus } from '../src/events.js';
import { Dispatcher } from '../src/dispatcher.js';
import { createApp } from '../src/server.js';
import type { Agent } from '../src/types.js';
import type { Launcher, RunResult } from '../src/launcher.js';

describe('loadConfig', () => {
  it('provides defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-cfg-'));
    const cfg = loadConfig(dir);
    expect(cfg.port).toBe(4680);
    expect(cfg.bounceCap).toBe(6);
    expect(cfg.timeoutMs).toBe(15 * 60_000);
    expect(cfg.sweepMs).toBe(15_000);
    expect(cfg.budgets.claude).toEqual({ soft: 0, hard: 0 });
    expect(cfg.budgets.gemini).toEqual({ soft: 0, hard: 0 });
    expect(cfg.budgets.deepseek).toEqual({ soft: 0, hard: 0 });
    expect(cfg.claudeCmd).toBe('claude');
    expect(cfg.codexCmd).toBe('codex');
    expect(cfg.geminiCmd).toBe('agy');
    expect(cfg.deepseekCmd).toBe('opencode');
    expect(cfg.claudeProjectsDir).toContain('.claude');
  });

  it('merges overrides from switchboard.config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-cfg-'));
    writeFileSync(join(dir, 'switchboard.config.json'), JSON.stringify({
      port: 5000,
      budgets: { claude: { soft: 100_000 } },
      tuning: { claude: { model: 'opus', effort: 'high' } },
    }));
    const cfg = loadConfig(dir);
    expect(cfg.port).toBe(5000);
    expect(cfg.budgets.claude).toEqual({ soft: 100_000, hard: 0 });
    expect(cfg.budgets.codex).toEqual({ soft: 0, hard: 0 });
    expect(cfg.bounceCap).toBe(6);
    expect(cfg.tuning.claude).toEqual({ model: 'opus', effort: 'high' });
    expect(cfg.tuning.codex).toEqual({});
    expect(cfg.modelChoices.claude).toContain('fable');
    expect(cfg.modelChoices.codex).toContain('gpt-5.6-luna');
  });

  it('loads the Nyx URL, token, and concurrency settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-cfg-'));
    writeFileSync(join(dir, 'switchboard.config.json'), JSON.stringify({
      agents: { nyx: { url: 'http://127.0.0.1:8000', token: 'secret', pollIntervalMs: 50 } },
      agentConcurrency: { nyx: 3 },
    }));
    const cfg = loadConfig(dir);
    expect(cfg.agents.nyx).toEqual({ url: 'http://127.0.0.1:8000', token: 'secret', pollIntervalMs: 50 });
    expect(cfg.agentConcurrency.nyx).toBe(3);
  });
});

describe('end-to-end with echo agent', () => {
  let httpServer: Server;

  afterEach(() => new Promise<void>(resolve => httpServer.close(() => resolve())));

  it.each(['codex', 'gemini', 'deepseek'] as Agent[])('dispatches a task to %s that reports back through MCP', async identity => {
    const store = new Store(':memory:');
    const bus = new EventBus();
    let port = 0;

    // Echo agent: stands in for a real CLI. When launched it connects to the
    // MCP endpoint AS that agent, comments, and finishes the task.
    const echoLauncher: Launcher = {
      async launch(agent: Agent, prompt: string): Promise<RunResult> {
        const idMatch = prompt.match(/task (\d+)/);
        const taskId = Number(idMatch![1]);
        const client = new Client({ name: 'echo-agent', version: '0.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${agent}`)));
        await client.callTool({ name: 'add_comment', arguments: { id: taskId, body: 'echo: got the prompt, work done' } });
        await client.callTool({ name: 'finish_task', arguments: { id: taskId, summary: 'echo: finished' } });
        await client.close();
        return { ok: true, timedOut: false, exitCode: 0, outputTail: 'echo ran', inputTokens: 42, outputTokens: 7, costEstimate: 0.001 };
      },
    };

    const dispatcher = new Dispatcher(store, echoLauncher, bus, {
      budgets: { claude: { soft: 0, hard: 0 }, codex: { soft: 0, hard: 0 } },
      bounceCap: 6,
    });
    const app = createApp({ store, bus, dispatcher });
    await new Promise<void>(resolve => {
      httpServer = app.listen(0, () => resolve());
    });
    port = (httpServer.address() as { port: number }).port;

    // Human registers a project and creates a task for the agent via the API.
    await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo', path: process.cwd() }),
    });
    const created = await (await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'demo', title: 'Echo something', description: 'test', assignee: identity }),
    })).json();

    // The dispatcher should launch the echo agent, which finishes the task.
    const deadline = Date.now() + 5000;
    let task = store.getTask(created.id)!;
    while (task.status !== 'review' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
      task = store.getTask(created.id)!;
    }
    expect(task.status).toBe('review');

    const comments = store.listComments(created.id);
    expect(comments.map(c => c.author)).toEqual([identity, identity]);
    expect(comments[0].body).toContain('echo: got the prompt');

    const run = store.listRuns(created.id)[0];
    expect(run.status).toBe('succeeded');
    expect(run.input_tokens).toBe(42);
    expect(run.agent).toBe(identity);
  }, 15_000);
});
