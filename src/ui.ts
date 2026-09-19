import type { Agent, Author, Comment, Project, Run, Task, TaskStatus } from './types.js';
import { AGENTS, TASK_STATUSES } from './types.js';
import type { BudgetLevel } from './budget.js';
import type { PlanUsage } from './plan-usage.js';

export interface BudgetView { used: number; soft: number; hard: number; level: BudgetLevel; }
export interface PlanView { usage: PlanUsage | null; maxPercent: number; blocked: boolean; }
export interface AgentInfo { model?: string; effort?: string; }
export interface MachineChoice { workerId: string | null; name: string; ip: string; configured: boolean; }
export interface BoardData {
  machines?: MachineChoice[];
  tasks: Task[];
  projects: Project[];
  budgets: Record<Agent, BudgetView>;
  plan: Record<Agent, PlanView>;
  agents: Record<Agent, AgentInfo>;
  modelChoices: Record<Agent, string[]>;
  deps: Record<number, { on: number[]; unmet: number[] }>;
  planningActive: boolean;
  paused: boolean;
  activeRuns: { runId: number; taskId: number; agent: Agent }[];
}
export interface TaskData {
  task: Task;
  project: Project;
  comments: Comment[];
  runs: Run[];
  activeRunId?: number;
}

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: 'inbox', ready: 'ready', in_progress: 'in_progress',
  review: 'review', needs_human: 'needs_human', done: 'done',
};

const STATUS_HELP: Record<TaskStatus, string> = {
  inbox: 'Parked for a human — never auto-dispatched. Assign it to an agent (claude, codex, nyx, gemini, deepseek) to queue it.',
  ready: 'Queued — the dispatcher launches the assigned agent as soon as that agent and project are free.',
  in_progress: 'An agent is working on it right now.',
  review: 'An agent finished and wants a human look. Set it to done, or comment and assign it back.',
  needs_human: 'Blocked on you — an agent question, a failed run, or the bounce cap. The thread has details.',
  done: 'Finished and accepted. Nothing more happens to it.',
};

const CSS = `
:root {
  color-scheme: dark;
  --bg: #080d1a;
  --surface: #10182a;
  --surface-raised: #142038;
  --surface-input: #0c1425;
  --border: #263451;
  --border-strong: #3a4b70;
  --text: #e8edf7;
  --muted: #8998b5;
  --violet: #b99aff;
  --cyan: #39d5e6;
  --claude: #9b4828;
  --claude-text: #ffd4c1;
  --codex: #16434b;
  --codex-text: #a6f0e5;
  --human: #584817;
  --human-text: #f5e6a1;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); }
a { color: var(--cyan); text-decoration: none; }
header { display: flex; align-items: center; gap: 1.2rem; padding: .55rem 1.2rem; background: var(--surface); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.brand { display: block; width: 220px; height: 52px; flex: 0 0 220px; overflow: hidden; border-radius: 7px; background: #050a15; }
.brand img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: center; }
header h1 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
header h1 a { color: var(--text); }
.banner { background: #702d2a; color: #ffe0da; padding: .5rem 1.2rem; text-align: center; }
.meters { display: flex; gap: 1rem; margin-left: auto; align-items: center; flex-wrap: wrap; }
.meter { font-size: .72rem; min-width: 150px; }
.meter .bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin-top: 2px; }
.meter .fill { height: 100%; background: #4d9e57; }
.meter.soft .fill { background: #c9a13b; }
.meter.hard .fill { background: #c94f4f; }
button { background: var(--surface-raised); color: var(--text); border: 1px solid var(--border-strong); border-radius: 6px; padding: .35rem .8rem; cursor: pointer; font-size: .8rem; transition: background .15s, border-color .15s, transform .15s; }
button:hover { background: #1d2d4b; border-color: var(--violet); }
button:active { transform: translateY(1px); }
button.danger { background: #5a2727; border-color: #8b3e3e; }
.board { display: grid; grid-template-columns: repeat(6, 1fr); gap: .7rem; padding: 1rem 1.2rem; align-items: start; }
.col h2 { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 .5rem .1rem; }
.card { display: block; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: .55rem .7rem; margin-bottom: .55rem; color: inherit; box-shadow: 0 5px 14px rgba(0, 0, 0, .12); }
.card:hover { border-color: var(--violet); background: var(--surface-raised); }
.card .t { font-size: .85rem; margin-bottom: .3rem; }
.more { display: block; width: 100%; background: transparent; border: 1px dashed var(--border); color: var(--muted); border-radius: 8px; padding: .45rem; margin-bottom: .55rem; font-size: .8rem; cursor: pointer; }
.more:hover { border-color: var(--violet); color: inherit; background: transparent; }
.badge { display: inline-block; font-size: .65rem; border-radius: 4px; padding: .06rem .4rem; margin-right: .3rem; }
.badge.claude { background: var(--claude); color: var(--claude-text); }
.badge.codex { background: var(--codex); color: var(--codex-text); }
.badge.human { background: var(--human); color: var(--human-text); }
.badge.proj { background: #1d2b46; color: #b4c4e2; }
.badge.run { background: #123c55; color: #a9f4ff; animation: pulse 1.2s infinite alternate; }
.badge.claude { background: #3b3358; color: #cfc3ff; }
.badge.codex { background: #1f4038; color: #a9e6cf; }
.badge.nyx { background: #4a3020; color: #f1c49f; }
.badge.gemini { background: #1c3a5e; color: #a8c8ff; }
.badge.deepseek { background: #3d1f4d; color: #d9b3f5; }
.badge.human { background: #45400f; color: #efe49a; }
.badge.proj { background: #2a2e38; color: #9aa3b5; }
.badge.run { background: #16324f; color: #9ecbff; animation: pulse 1.2s infinite alternate; }
@keyframes pulse { from { opacity: .6; } to { opacity: 1; } }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 1rem 1.2rem; margin: 1rem 1.2rem; box-shadow: 0 7px 22px rgba(0, 0, 0, .12); }
.panel h2 { font-size: .9rem; margin: 0 0 .7rem; color: #c8d4ea; }
form.inline { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
input, select, textarea { background: var(--surface-input); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: .35rem .5rem; font-size: .82rem; font-family: inherit; }
input:focus, select:focus, textarea:focus { outline: 2px solid var(--cyan); outline-offset: 1px; border-color: var(--cyan); }
textarea { width: 100%; min-height: 70px; }
.comment { border-left: 3px solid var(--border-strong); padding: .35rem .7rem; margin: .5rem 0; white-space: pre-wrap; font-size: .85rem; }
.comment.claude { border-color: var(--claude); }
.comment.codex { border-color: var(--cyan); }
.comment.nyx { border-color: #a4652f; }
.comment.gemini { border-color: #4a7bc4; }
.comment.deepseek { border-color: #8b5cb8; }
.comment.human { border-color: #d8c04a; }
.comment .who { font-size: .68rem; color: var(--muted); margin-bottom: .15rem; }
pre.output { background: #050a14; border: 1px solid var(--border); border-radius: 6px; padding: .7rem; font-size: .72rem; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
table.runs { border-collapse: collapse; font-size: .78rem; width: 100%; }
table.runs td, table.runs th { border-bottom: 1px solid var(--border); padding: .3rem .5rem; text-align: left; }
.muted { color: var(--muted); font-size: .75rem; }
details.panel summary { cursor: pointer; font-size: .85rem; color: #c8d4ea; user-select: none; }
details.panel[open] summary { margin-bottom: .6rem; }
.help li { font-size: .82rem; margin: .3rem 0; color: #b9c0cd; }
.help b { color: var(--text); }
.col h2 { cursor: help; }
@media (max-width: 900px) { .board { grid-template-columns: repeat(2, 1fr); } .brand { width: 190px; flex-basis: 190px; } }
@media (max-width: 520px) { .board { grid-template-columns: 1fr; } }
`;

const boardScript = `
const es = new EventSource('/events');
let pending = null;
let refreshing = false;
let refreshAgain = false;
const fragments = new Map([...document.querySelectorAll('[data-live]')].map(el => [el.dataset.live, el.innerHTML]));
function scheduleRefresh() { clearTimeout(pending); pending = setTimeout(refreshPage, 400); }
es.onmessage = scheduleRefresh;
es.onopen = scheduleRefresh; // Refresh on the first open too, since changes can occur between rendering and subscribing.
async function refreshPage() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    const res = await fetch(location.pathname, { cache: 'no-store' });
    if (!res.ok) return;
    const next = new DOMParser().parseFromString(await res.text(), 'text/html');
    const x = window.scrollX, y = window.scrollY;
    for (const region of document.querySelectorAll('[data-live]')) {
      const incoming = next.querySelector('[data-live="' + region.dataset.live + '"]');
      if (!incoming || fragments.get(region.dataset.live) === incoming.innerHTML) continue;
      const scrolls = [...region.querySelectorAll('.col, .output')].map(el => [el.scrollLeft, el.scrollTop]);
      fragments.set(region.dataset.live, incoming.innerHTML);
      region.innerHTML = incoming.innerHTML;
      region.querySelectorAll('.col, .output').forEach((el, i) => {
        if (scrolls[i]) { el.scrollLeft = scrolls[i][0]; el.scrollTop = scrolls[i][1]; }
      });
    }
    // Refresh project choices without replacing form controls or disturbing drafts/focus.
    for (const select of document.querySelectorAll('select[name="project"]')) {
      const incoming = next.querySelector('select[name="project"]');
      if (!incoming || select.innerHTML === incoming.innerHTML) continue;
      const value = select.value;
      select.innerHTML = incoming.innerHTML;
      if ([...select.options].some(option => option.value === value)) select.value = value;
    }
    // Task-page controls live outside the live regions so an in-progress edit is never
    // clobbered; when the viewer has not touched them, follow the server's current value.
    for (const select of document.querySelectorAll('select[data-rendered]')) {
      const incoming = next.querySelector('select[name="' + select.name + '"][data-rendered]');
      if (!incoming || incoming.dataset.rendered === select.dataset.rendered) continue;
      const untouched = select.value === select.dataset.rendered;
      select.dataset.rendered = incoming.dataset.rendered;
      if (untouched) select.value = incoming.dataset.rendered;
    }
    restoreFolds();
    window.scrollTo(x, y);
  } catch { /* retain the current view during a transient network failure */ }
  finally {
    refreshing = false;
    if (refreshAgain) { refreshAgain = false; scheduleRefresh(); }
  }
}
async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  if (!res.ok) { alert(await res.text()); return false; }
  await refreshPage();
  return true;
}
function submitForm(e, path) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form).entries());
  const buttons = [...form.querySelectorAll('button[type="submit"]')];
  buttons.forEach(button => button.disabled = true);
  api(path, data).then(ok => {
    if (ok && JSON.stringify(Object.fromEntries(new FormData(form).entries())) === JSON.stringify(data)) {
      form.querySelectorAll('textarea, input:not([type="checkbox"]):not([type="hidden"])').forEach(input => input.value = '');
    }
  }).catch(() => alert('Could not reach Switchboard. Your draft is preserved.'))
    .finally(() => buttons.forEach(button => button.disabled = false));
  return false;
}
// Preserve expanded columns across live updates and deliberate navigation.
function toggleMore(col) {
  const box = document.getElementById('more-' + col);
  const btn = document.querySelector('.more[data-col="' + col + '"]');
  if (!box || !btn) return;
  const open = box.hidden;
  box.hidden = !open;
  btn.textContent = open ? '- hide ' + box.children.length + ' older' : '+ ' + box.children.length + ' more';
  try {
    const s = JSON.parse(sessionStorage.getItem('moreOpen') || '{}');
    s[col] = open;
    sessionStorage.setItem('moreOpen', JSON.stringify(s));
  } catch {}
}
function restoreFolds() { try {
  const s = JSON.parse(sessionStorage.getItem('moreOpen') || '{}');
  for (const col of Object.keys(s)) if (s[col] && document.getElementById('more-' + col)?.hidden) toggleMore(col);
} catch {} }
restoreFolds();
async function pollOutput() {
  const el = document.getElementById('live');
  const run = el?.dataset.run;
  if (run) try {
    const res = await fetch('/api/runs/' + run + '/output', { cache: 'no-store' });
    if (res.ok && document.getElementById('live') === el) {
      const data = await res.json();
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (el.textContent !== data.output) el.textContent = data.output || '(no output yet)';
      if (bottom) el.scrollTop = el.scrollHeight;
    }
  } catch {}
  setTimeout(pollOutput, 2000);
}
if (location.pathname.startsWith('/task/')) pollOutput();
`;

export function layout(title: string, body: string, extraScript = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head>
<body>${body}<script>${boardScript}${extraScript}</script></body></html>`;
}

// Windows we can name; unknown extra buckets from the usage endpoint are shown only once they have real usage.
const KNOWN_PLAN_LABELS = new Set(['session', 'week', '5h', 'week (opus)', 'week (sonnet)', 'week (apps)']);

function meter(agent: Agent, b: BudgetView, p: PlanView, info: AgentInfo): string {
  const tune = [info.model, info.effort].filter(Boolean).join(' · ');
  const name = tune ? `${agent} (${tune})` : agent;
  // Prefer TRUE plan usage (same source as the CLIs' /usage and /status screens).
  if (p.usage) {
    const windows = p.usage.windows.filter(w => w.usedPercent > 0 || KNOWN_PLAN_LABELS.has(w.label));
    const maxPct = Math.max(0, ...p.usage.windows.map(w => w.usedPercent));
    const level = p.blocked || maxPct >= 90 ? 'hard' : maxPct >= 70 ? 'soft' : 'ok';
    const parts = windows.map(w => `${w.label} ${Math.round(w.usedPercent)}%`).join(' · ');
    const gate = p.maxPercent > 0 ? ` (gate ${p.maxPercent}%)` : '';
    return `<div class="meter ${level}" title="True plan usage — the same numbers the CLI's own /usage or /status screen shows, refreshed every few minutes.${gate ? ' Dispatch stops at the gate percentage.' : ''}">
      ${esc(name)} plan: ${esc(parts)}${esc(gate)}${p.blocked ? ' ⛔' : ''}
      <div class="bar"><div class="fill" style="width:${Math.min(100, Math.round(maxPct))}%"></div></div></div>`;
  }
  const limit = b.hard || b.soft;
  const pct = limit ? Math.min(100, Math.round((b.used / limit) * 100)) : 0;
  const label = limit
    ? `${agent}: ${b.used.toLocaleString()} / ${limit.toLocaleString()} tok (5h)`
    : `${agent}: ${b.used.toLocaleString()} tok (5h, no limit)`;
  return `<div class="meter ${b.level}" title="Measured consumption estimate — true plan usage unavailable">
    ${esc(label)}<div class="bar"><div class="fill" style="width:${pct}%"></div></div></div>`;
}

function header(data: BoardData): string {
  return `<div data-live="header"><header>
    <a class="brand" href="/" aria-label="Switchboard home"><img src="/logo.png" alt="Switchboard"></a>
    <h1><a href="/">SWITCHBOARD</a></h1>
    ${data.paused
      ? '<button onclick="api(\'/api/resume\')">▶ Resume dispatch</button>'
      : '<button class="danger" onclick="api(\'/api/pause\')">⏸ Pause dispatch</button>'}
    <span class="muted">${data.activeRuns.length ? data.activeRuns.map(r => `<span class="badge run">${esc(r.agent)} running #${r.taskId}</span>`).join(' ') : 'idle'}</span>
    <div class="meters">${AGENTS.map(a => meter(a, data.budgets[a], data.plan[a], data.agents[a])).join('')}</div>
  </header>${data.paused ? '<div class="banner">Dispatch is paused — agents will not be launched.</div>' : ''}</div>`;
}

function card(t: Task, projects: Project[], activeRuns: BoardData['activeRuns'], deps?: { on: number[]; unmet: number[] }): string {
  const proj = projects.find(p => p.id === t.project_id);
  const running = activeRuns.some(r => r.taskId === t.id);
  const waiting = deps && deps.unmet.length
    ? `<span class="muted" title="Dispatches after these tasks reach review/done">⛓ ${deps.unmet.map(d => '#' + d).join(' ')}</span>`
    : '';
  return `<a class="card" href="/task/${t.id}">
    <div class="t">${esc(t.title)}</div>
    <span class="badge proj">${esc(proj?.name ?? '?')}</span>
    <span class="badge ${esc(t.assignee)}">${esc(t.assignee)}</span>
    ${t.worker_id ? `<span class="badge">PC: ${esc(t.worker_id)}</span>` : ''}
    ${running ? '<span class="badge run">running</span>' : ''}
    ${t.bounce_count > 0 ? `<span class="muted">↺${t.bounce_count}</span>` : ''}
    ${waiting}
  </a>`;
}

/** Cards shown per column before the rest folds behind a "+ N more" button. */
export const COLLAPSE_AFTER = 5;

const ASSIGNEE_OPTIONS = [...AGENTS, 'human' as const].map(a => `<option value="${a}">${a}</option>`).join('');

function renderColumnCards(status: TaskStatus, data: BoardData): string {
  // Newest first: listTasks() comes back oldest-first, and a review column
  // holding fifty finished cards otherwise pushes every later column (needs
  // human, done, the dispatch panels) off the bottom of a phone screen.
  const cards = data.tasks
    .filter(t => t.status === status)
    .reverse()
    .map(t => card(t, data.projects, data.activeRuns, data.deps[t.id]));
  const shown = cards.slice(0, COLLAPSE_AFTER);
  const rest = cards.slice(COLLAPSE_AFTER);
  if (rest.length === 0) return shown.join('');
  return `${shown.join('')}
      <button class="more" data-col="${status}" onclick="toggleMore('${status}')" title="Show the ${rest.length} older card${rest.length > 1 ? 's' : ''} in this column">+ ${rest.length} more</button>
      <div class="more-cards" id="more-${status}" hidden>${rest.join('')}</div>`;
}

export function renderBoard(data: BoardData): string {
  const releasable = data.tasks.filter(t => t.status === 'inbox' && t.assignee !== 'human').length;
  const cols = TASK_STATUSES.map(status => `
    <div class="col"><h2 title="${esc(STATUS_HELP[status])}">${esc(STATUS_LABELS[status])}</h2>
      ${status === 'inbox' && releasable > 0
        ? (data.planningActive
          ? '<p class="muted" style="margin:.2rem 0 .5rem">🧠 planner still creating tasks — release unlocks when it finishes</p>'
          : `<button style="margin-bottom:.5rem;width:100%" title="Queue every agent-assigned inbox task. Dispatch starts immediately, honoring declared dependencies." onclick="api('/api/tasks/release')">▶ Release ${releasable} draft${releasable > 1 ? 's' : ''}</button>`)
        : ''}
      ${renderColumnCards(status, data)}
    </div>`).join('');

  const projectOptions = data.projects.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');

  const help = `
  <details class="panel help">
    <summary>❓ How Switchboard works</summary>
    <ul>
      <li><b>The board is shared.</b> You use this page; the agents (Claude Code, Codex, Nyx, Gemini, DeepSeek) use the same board through MCP tools. Everyone sees the same tasks and threads.</li>
      <li><b>Assigning is dispatching.</b> Put a task in <b>ready</b> assigned to an agent and Switchboard launches it automatically in the project's folder — no terminal needed. Hover any column header for what that column means.</li>
      <li><b>Agents talk in the thread.</b> Open a task to read their comments, answer questions, and watch live output while a run is going.</li>
      <li><b>Hand-offs are automatic.</b> An agent can assign a task to another agent (e.g. "codex, review my work"); the other agent launches as soon as it's free. A bounce cap stops infinite ping-pong.</li>
      <li><b>The meters are your real limits</b> — the same numbers as <code>/usage</code> in Claude and agy, <code>/status</code> in Codex. Green is fine, yellow ≥70%, red ≥90%. Anthropic and Gemini windows refill on a timer; OpenAI's weekly window resets on the date shown. DeepSeek is pay-per-token (real cost in the Runs table).</li>
      <li><b>Pause</b> stops new agent launches instantly (running agents finish). Nothing is lost — resume whenever.</li>
      <li><b>Plan a project</b> sends your goal to one high-effort planning run (claude or codex) that creates the work tasks and distributes them among the agents — then the workers simply follow the board.</li>
      <li><b>Projects</b> are just folders agents work in. Register any repo below, then create tasks against it.</li>
    </ul>
  </details>`;

  const EFFORT_OPTIONS: Partial<Record<Agent, string[]>> = {
    claude: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    gemini: ['low', 'medium', 'high'],
  };
  const effortSelect = (agent: Agent, current: string | undefined, options: string[]): string =>
    options.length ? `
    <select name="effort" title="Reasoning effort for ${agent}'s dispatched runs. Default = the CLI's own setting.">
      <option value="">effort: default</option>
      ${options.map(o => `<option value="${o}" ${o === current ? 'selected' : ''}>${o}</option>`).join('')}
    </select>` : '';
  // Hardcoded-but-configurable model list (config: modelChoices). A configured model that
  // isn't in the list still renders as a selected extra option rather than disappearing.
  const modelSelect = (agent: Agent, current: string | undefined, models: string[]): string => {
    const extra = current && !models.includes(current) ? [current] : [];
    return `
    <select name="model" title="Model for ${agent}'s dispatched runs. Claude entries are aliases that always point at the latest of each family. Edit modelChoices in switchboard.config.json to update this list.">
      <option value="">model: default</option>
      ${[...extra, ...models].map(m => `<option value="${esc(m)}" ${m === current ? 'selected' : ''}>${esc(m)}</option>`).join('')}
    </select>`;
  };

  const tuningRow = (agent: Agent, info: AgentInfo, models: string[], efforts: string[]): string => `
    <form class="inline" style="margin-bottom:.4rem" onsubmit="return submitForm(event, '/api/tuning')">
      <input type="hidden" name="agent" value="${agent}">
      <span class="badge ${agent}" style="width:52px;text-align:center">${agent}</span>
      ${modelSelect(agent, info.model, models)}
      ${effortSelect(agent, info.effort, efforts)}
      <button type="submit">Apply</button>
    </form>`;

  const tuningPanel = `
  <div class="panel"><h2 title="Applies from the NEXT dispatched run (running agents are unaffected) and is saved to switchboard.config.json.">Agent tuning</h2>
    ${AGENTS.map(a => tuningRow(a, data.agents[a], data.modelChoices[a] ?? [], EFFORT_OPTIONS[a] ?? [])).join('')}
    <p class="muted">Claude effort sets the extended-thinking budget (off→0 … max→64k tokens). Codex effort sets model_reasoning_effort. Gemini effort maps onto agy's low/medium/high. DeepSeek and nyx take no effort knob. Saved to switchboard.config.json, applied to the next run — no restart needed.</p>
  </div>`;

  const plannerPanel = `
  <div class="panel"><h2 title="One high-effort run that breaks your goal into tasks and distributes them between the agents. The workers then just follow the board.">🧠 Plan a project</h2>
    <form onsubmit="return submitForm(event, '/api/plan')">
      <textarea name="goal" required
        placeholder="Describe the goal in plain words — e.g. 'Add user accounts with login, profile page, and tests'. The planner explores the project, splits this into tasks with acceptance criteria, assigns each to an agent (optionally picking a brain per task), and reports the plan back for you to watch unfold."></textarea>
      <div class="inline" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-top:.4rem">
        <select name="project" title="Which project the plan (and its tasks) belong to." required>${projectOptions}</select>
        <select name="planner" id="planner-agent" title="Which agent does the planning."
          onchange="plannerModels(this.value)">
          <option value="claude">planner: claude</option>
          <option value="codex">planner: codex</option>
        </select>
        <select name="model" id="planner-model" title="Brain for the planning run only. Options follow the chosen planner; edit modelChoices in switchboard.config.json to update.">
          <option value="">model: default</option>
          ${data.modelChoices.claude.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}
        </select>
        <script>
          const MODEL_CHOICES = ${JSON.stringify(data.modelChoices)};
          function plannerModels(agent) {
            const sel = document.getElementById('planner-model');
            sel.replaceChildren();
            const dflt = document.createElement('option');
            dflt.value = '';
            dflt.textContent = 'model: default';
            sel.append(dflt);
            for (const m of MODEL_CHOICES[agent] ?? []) {
              const opt = document.createElement('option');
              opt.value = m;
              opt.textContent = m;
              sel.append(opt);
            }
          }
        </script>
        <select name="effort" title="Effort for the planning run. off/max are Claude thinking budgets; minimal is Codex-only.">
          <option value="">planner effort: default</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
          <option value="max">max (claude)</option>
          <option value="medium">medium</option>
          <option value="low">low</option>
          <option value="minimal">minimal (codex)</option>
          <option value="off">off (claude)</option>
        </select>
        <label class="muted" style="display:flex;gap:.3rem;align-items:center;cursor:pointer"
          title="The planner's tasks park in the inbox (keeping their assignee and brain) instead of dispatching. Review the plan, then hit '▶ Release drafts' on the inbox column to start execution.">
          <input type="checkbox" name="draft" checked> draft mode
        </label>
        <button type="submit">Plan it</button>
      </div>
    </form>
  </div>`;

  const assigneeOptions = ASSIGNEE_OPTIONS;
  const machineOptions = (data.machines ?? [{ workerId: null, name: 'This PC', ip: '', configured: true }])
    .map(pc => `<option value="${esc(pc.workerId ?? '')}"${pc.configured ? '' : ' disabled'}>${esc(pc.name)}${pc.ip ? ` — ${esc(pc.ip)}` : ''}${pc.workerId === null ? ' (local)' : pc.configured ? ' (registered)' : ' (setup needed)'}</option>`).join('');

  const forms = `
  ${plannerPanel}
  ${tuningPanel}
  <div class="panel"><h2 title="Describe the work, pick who starts it. Assigning an agent dispatches immediately; assigning human parks it in inbox.">New task</h2>
    <form class="inline" onsubmit="return submitForm(event, '/api/tasks')">
      <select name="project" required>${projectOptions}</select>
      <input name="title" placeholder="Title" required style="flex:1;min-width:200px">
      <input name="description" placeholder="Description" style="flex:2;min-width:260px">
      <select name="assignee">${assigneeOptions}</select>
      <label>Run on PC <select name="worker_id" aria-label="Run on PC" title="Registered does not mean online. Each remote PC needs a running worker and a mapping for the selected project.">${machineOptions}</select></label>
      <button type="submit">Create</button>
    </form>
  </div>
  <div class="panel"><h2 title="A project is a folder on this machine. Dispatched agents run inside it (one agent per project at a time).">Register project</h2>
    <form class="inline" onsubmit="return submitForm(event, '/api/projects')">
      <input name="name" placeholder="name" required>
      <input name="path" placeholder="working directory (absolute path, e.g. Z:\\Repos\\MyApp)" required style="flex:1;min-width:280px">
      <button type="submit">Add</button>
    </form>
  </div>`;

  return layout('Switchboard', `${header(data)}<div class="board" data-live="board">${cols}</div>${help}${forms}`);
}

export function renderTask(data: TaskData, board: BoardData): string {
  const { task, project, comments, runs, activeRunId } = data;

  const thread = comments.length
    ? comments.map(c => `<div class="comment ${esc(c.author)}"><div class="who">${esc(c.author)} · ${esc(c.created_at)}</div>${esc(c.body)}</div>`).join('')
    : '<p class="muted">No comments yet.</p>';

  const runRows = runs.map(r => `<tr>
    <td>#${r.id}</td><td>${esc(r.agent)}</td><td>${esc(r.status)}</td>
    <td>${r.input_tokens + r.output_tokens} tok</td><td>$${r.cost_estimate.toFixed(4)}</td>
    <td>${esc(r.started_at)}</td></tr>`).join('');

  const statusOptions = TASK_STATUSES.map(s =>
    `<option value="${s}" ${s === task.status ? 'selected' : ''}>${s}</option>`).join('');

  const live = activeRunId
    ? `<h2>Live output (run #${activeRunId})</h2><pre class="output" id="live" data-run="${activeRunId}">…</pre>`
    : '';

  const body = `${header(board)}
  <div class="panel">
    <div data-live="task-summary">
    <h2>#${task.id} · ${esc(task.title)}
      <span class="badge proj">${esc(project.name)}</span>
      <span class="badge ${esc(task.assignee)}">${esc(task.assignee)}</span>
      <span class="badge proj">${esc(task.status)}</span>
    </h2>
    <p style="white-space:pre-wrap">${esc(task.description) || '<span class="muted">(no description)</span>'}</p>
    <p class="muted">created by ${esc(task.created_by)} · bounces ${task.bounce_count} · dir ${esc(project.path)}${task.model || task.effort ? ` · brain: ${esc([task.model, task.effort].filter(Boolean).join(' · '))}` : ''}${board.deps[task.id] ? ` · depends on ${board.deps[task.id].on.map(d => `<a href="/task/${d}">#${d}</a>`).join(', ')}${board.deps[task.id].unmet.length ? ` (waiting: ${board.deps[task.id].unmet.map(d => '#' + d).join(', ')})` : ' (all satisfied)'}` : ''}</p>
    <p class="muted">${esc(STATUS_HELP[task.status] ?? '')}</p>
    </div>
    <form class="inline" title="Move the task manually. Setting 'ready' (with an agent assignee) re-dispatches it." onsubmit="return submitForm(event, '/api/tasks/${task.id}/status')">
      <select name="status" data-rendered="${task.status}">${statusOptions}</select><button type="submit">Set status</button>
    </form>
    <form class="inline" style="margin-top:.4rem" title="Hand the task to an agent (launches them when free) or to 'human' (parks it for you)." onsubmit="return submitForm(event, '/api/tasks/${task.id}/assign')">
      <select name="assignee">${ASSIGNEE_OPTIONS}</select>
      <button type="submit">Assign (re-queues)</button>
    </form>
  </div>
  <div class="panel"><h2>Thread</h2><div data-live="thread">${thread}</div>
    <form onsubmit="return submitForm(event, '/api/tasks/${task.id}/comment')">
      <textarea name="body" placeholder="Comment as human…" required></textarea>
      <button type="submit" style="margin-top:.4rem">Post</button>
    </form>
  </div>
  <div class="panel" data-live="runs">${live}<h2>Runs</h2>
    ${runs.length ? `<table class="runs"><tr><th>run</th><th>agent</th><th>status</th><th>tokens</th><th>cost</th><th>started</th></tr>${runRows}</table>` : '<p class="muted">No runs yet.</p>'}
  </div>`;

  return layout(`#${task.id} ${task.title} — Switchboard`, body);
}
