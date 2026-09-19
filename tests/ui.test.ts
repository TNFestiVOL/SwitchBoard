import { describe, expect, it } from 'vitest';
import { COLLAPSE_AFTER, renderBoard, renderTask, type BoardData, type TaskData } from '../src/ui.js';
import type { Task } from '../src/types.js';

const budget = { used: 0, soft: 0, hard: 0, level: 'ok' as const };
const plan = { usage: null, maxPercent: 0, blocked: false };

function task(id: number, status: Task['status']): Task {
  return {
    id, project_id: 1, title: `Card ${id}`, description: '', status, assignee: 'codex', created_by: 'human',
    bounce_count: 0, model: null, effort: null, created_at: `2026-09-03T00:00:${String(id).padStart(2, '0')}Z`,
    updated_at: `2026-09-03T00:00:${String(id).padStart(2, '0')}Z`,
  };
}

function board(tasks: Task[]): BoardData {
  return {
    tasks,
    projects: [{ id: 1, name: 'proj', path: 'Z:/proj', created_at: '' }],
    budgets: { claude: budget, codex: budget, nyx: budget, gemini: budget, deepseek: budget },
    plan: { claude: plan, codex: plan, nyx: plan, gemini: plan, deepseek: plan },
    agents: { claude: {}, codex: {}, nyx: {}, gemini: {}, deepseek: {} },
    modelChoices: { claude: [], codex: [], nyx: [], gemini: [], deepseek: [] },
    deps: {},
    planningActive: false,
    paused: false,
    activeRuns: [],
  };
}

describe('board columns fold after the newest cards', () => {
  it('shows every card and no fold button when a column is short', () => {
    const html = renderBoard(board([task(1, 'review'), task(2, 'review')]));
    expect(html).not.toContain('class="more"');
    expect(html).not.toContain('id="more-review"');
    expect(html).toContain('Card 1');
    expect(html).toContain('Card 2');
  });

  it('keeps the newest N visible and folds the older ones behind "+ N more"', () => {
    // listTasks() is ordered by updated_at ascending: id 1 is the oldest.
    const tasks = Array.from({ length: COLLAPSE_AFTER + 3 }, (_, i) => task(i + 1, 'review'));
    const html = renderBoard(board(tasks));
    expect(html).toContain(`data-col="review"`);
    expect(html).toContain('+ 3 more');
    const fold = html.indexOf('id="more-review"');
    expect(fold).toBeGreaterThan(0);
    const visible = html.slice(0, fold);
    const hidden = html.slice(fold);
    // newest three above the fold …
    for (const id of [8, 7, 6, 5, 4]) expect(visible).toContain(`Card ${id}<`);
    // … the oldest three folded, hidden until the viewer expands the column.
    for (const id of [1, 2, 3]) {
      expect(visible).not.toContain(`Card ${id}<`);
      expect(hidden).toContain(`Card ${id}<`);
    }
    expect(hidden).toMatch(/id="more-review" hidden>/);
  });

  it('folds each column independently', () => {
    const tasks = [
      ...Array.from({ length: COLLAPSE_AFTER + 1 }, (_, i) => task(i + 1, 'done')),
      task(50, 'in_progress'),
    ];
    const html = renderBoard(board(tasks));
    expect(html).toContain('id="more-done"');
    expect(html).not.toContain('id="more-in_progress"');
    expect(html).not.toContain('id="more-review"');
  });

  it('renders every agent: meters, tuning rows, and full assignee dropdowns', () => {
    const html = renderBoard(board([task(1, 'ready')]));
    for (const agent of ['claude', 'codex', 'nyx', 'gemini', 'deepseek']) {
      expect(html).toContain(`badge ${agent}`); // card assignee badge styling exists
      expect(html).toContain(`"agent" value="${agent}"`); // tuning row submits per agent
    }
    expect(html.match(/<option value="gemini">gemini<\/option>/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).toContain('<option value="deepseek">deepseek</option>');
    expect(html).toContain('<option value="nyx">nyx</option>'); // previously missing from the dropdowns
    expect(html).toContain('badge gemini" style'); // tuning panel badge
    // gemini gets a low|medium|high effort select; deepseek gets none
    expect(html).toContain('Reasoning effort for gemini');
    expect(html).not.toContain('Reasoning effort for deepseek');
  });
});

describe('live refresh script', () => {
  it('never clears hidden inputs when resetting a submitted form', () => {
    const html = renderBoard(board([]));
    // The tuning rows carry <input type="hidden" name="agent">; wiping it broke the second Apply.
    expect(html).toContain('input:not([type="checkbox"]):not([type="hidden"])');
  });

  it('only catches up on SSE reconnects and only polls output on task pages', () => {
    const html = renderBoard(board([]));
    expect(html).toContain('if (connected) scheduleRefresh()');
    expect(html).toContain("if (location.pathname.startsWith('/task/')) pollOutput();");
  });
});

describe('task page controls', () => {
  const data = (status: Task['status']): TaskData => ({
    task: task(1, status),
    project: { id: 1, name: 'proj', path: 'Z:/proj', created_at: '' },
    comments: [],
    runs: [],
  });

  it('marks the status select with the rendered status so live refresh can follow it', () => {
    const html = renderTask(data('in_progress'), board([task(1, 'in_progress')]));
    expect(html).toContain('<select name="status" data-rendered="in_progress">');
    expect(html).toContain('<option value="in_progress" selected>');
    expect(html).toContain('select[data-rendered]');
  });
});
