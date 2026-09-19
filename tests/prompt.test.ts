import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../src/prompt.js';
import type { Comment, Project, Task } from '../src/types.js';

const project: Project = { id: 1, name: 'staging', path: 'Z:/Repos/Staging', created_at: '' };
const task: Task = {
  id: 7, project_id: 1, title: 'Add health endpoint', description: 'GET /health returning 200',
  status: 'ready', assignee: 'claude', created_by: 'human', bounce_count: 1,
  model: null, effort: null, created_at: '', updated_at: '',
};
const comment = (id: number, author: Comment['author'], body: string): Comment =>
  ({ id, task_id: 7, author, body, created_at: '' });

describe('buildPrompt', () => {
  it('includes task, project path, and thread', () => {
    const p = buildPrompt({
      task, project, agent: 'claude',
      comments: [comment(1, 'human', 'please keep it tiny'), comment(2, 'codex', 'I stubbed the router')],
    });
    expect(p).toContain('task 7');
    expect(p).toContain('Add health endpoint');
    expect(p).toContain('GET /health returning 200');
    expect(p).toContain('Z:/Repos/Staging');
    expect(p).toContain('[human] please keep it tiny');
    expect(p).toContain('[codex] I stubbed the router');
  });

  it('limits to the last maxComments, oldest first', () => {
    const comments = Array.from({ length: 15 }, (_, i) => comment(i + 1, 'human', `note ${i + 1}`));
    const p = buildPrompt({ task, project, agent: 'claude', comments, maxComments: 10 });
    expect(p).not.toContain('note 5\n');
    expect(p).toContain('note 6');
    expect(p).toContain('note 15');
    expect(p.indexOf('note 6')).toBeLessThan(p.indexOf('note 15'));
  });

  it('carries the standing tool instructions and names the hand-off targets', () => {
    const p = buildPrompt({ task, project, agent: 'claude', comments: [] });
    for (const s of ['switchboard', 'add_comment', 'finish_task', 'assign_task', 'update_status', 'needs_human']) {
      expect(p).toContain(s);
    }
    expect(p).toContain('codex'); // hand-off target for claude
    const p2 = buildPrompt({ task, project, agent: 'codex', comments: [] });
    expect(p2).toContain('claude');
  });

  it('offers every other agent as a hand-off target, excluding the runner itself', () => {
    const p = buildPrompt({ task, project, agent: 'gemini', comments: [] });
    expect(p).toContain('("claude", "codex", "nyx", "deepseek")'); // exact targets, self excluded
    const roster = buildPrompt({ task, project, agent: 'deepseek', comments: [] });
    expect(roster).toContain('"gemini"');
    expect(roster).toContain('("claude", "codex", "nyx", "gemini")');
  });
  it('remote runs get a scoped prompt without hand-off instructions', () => {
    const p = buildPrompt({ task, project, agent: 'codex', comments: [], remote: { workerId: 'in-amber-clad' } });
    expect(p).toContain('remote worker "in-amber-clad"');
    expect(p).not.toContain('assign_task');
    expect(p).toContain('stay on this PC');
    expect(p).toContain('finish_task or update_status');
  });
});
