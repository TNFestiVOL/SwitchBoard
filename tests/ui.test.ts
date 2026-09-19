import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
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
    draining: false,
    activeRuns: [],
  };
}

type Attention = Pick<Task, 'id' | 'title' | 'status'>;

function livePage(initial: Attention[] = [], permission: NotificationPermission | 'unsupported' = 'granted') {
  const html = renderBoard(board([]));
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('new EventSource'))![1];
  const attention = { textContent: JSON.stringify(initial) };
  let alertsButton = { hidden: true };
  let headerHtml = JSON.stringify({ attention: initial, revision: 0 });
  let incomingHtml = headerHtml;
  const header = {
    dataset: { live: 'header' },
    get innerHTML() { return headerHtml; },
    set innerHTML(value: string) {
      headerHtml = value;
      attention.textContent = JSON.stringify(JSON.parse(value).attention);
      alertsButton = { hidden: true };
    },
    querySelectorAll: () => [],
  };
  let title = '';
  const setTitle = vi.fn((value: string) => { title = value; });
  const document = {
    get title() { return title; },
    set title(value: string) { setTitle(value); },
    getElementById: (id: string) => id === 'attention' ? attention : id === 'enable-alerts' ? alertsButton : null,
    querySelectorAll: (selector: string) => selector === '[data-live]' ? [header] : [],
  };
  const Notification = Object.assign(vi.fn(), {
    permission,
    requestPermission: vi.fn(async () => Notification.permission),
  });
  const es = { onmessage: (_event: { data: string }) => {}, onopen: () => {} };
  const fetch = vi.fn(async (_path: string, _options?: { method?: string; body?: string }) => ({
    ok: true, status: 200, text: async () => incomingHtml,
  }));
  const context = {
    EventSource: function () { return es; },
    document,
    Notification: permission === 'unsupported' ? undefined : Notification,
    window: { Notification: permission === 'unsupported' ? undefined : Notification, scrollX: 0, scrollY: 0, scrollTo: vi.fn() },
    DOMParser: function () {
      return { parseFromString: (text: string) => ({
        querySelector: (selector: string) => selector === '[data-live="header"]' ? { innerHTML: text } : null,
      }) };
    },
    fetch,
    location: { pathname: '/', reload: vi.fn() },
    sessionStorage: { getItem: () => null },
    setTimeout: vi.fn(), clearTimeout: vi.fn(),
  };
  runInNewContext(script, context);
  return {
    context, document, Notification, fetch, es, setTitle,
    get alertsButton() { return alertsButton; },
    snapshot(entries: Attention[], revision = 0) { incomingHtml = JSON.stringify({ attention: entries, revision }); },
    refresh: () => runInNewContext('refreshPage()', context) as Promise<void>,
    enableAlerts: () => {
      const onclick = html.match(/<button[^>]*id="enable-alerts"[^>]*onclick="([^"]+)"/)![1];
      return runInNewContext(onclick, context) as Promise<void>;
    },
  };
}

describe('attention list', () => {
  it('renders attention counts, escaped tooltips, and a safe JSON island inside the live header', () => {
    const first = { ...task(1, 'needs_human'), title: '<script>"&</script>' };
    const second = task(2, 'review');
    const html = renderBoard(board([first, second, task(3, 'in_progress'), task(4, 'done')]));
    const header = html.match(/<div data-live="header">([\s\S]*?)<\/header>/)![1];
    expect(header).toContain('<span class="badge attn" title="#1 &lt;script&gt;&quot;&amp;&lt;/script&gt; (needs_human)\n#2 Card 2 (review)">2 need you</span>');
    const json = header.match(/<script type="application\/json" id="attention">([\s\S]*?)<\/script>/)![1];
    expect(json).toContain('\\u003cscript>');
    expect(json).not.toContain('<');
    expect(JSON.parse(json)).toEqual([first, second].map(({ id, title, status }) => ({ id, title, status })));
  });

  it('omits the attention badge and renders an empty snapshot when nobody needs attention', () => {
    const html = renderBoard(board([task(1, 'ready')]));
    expect(html).not.toContain('class="badge attn"');
    expect(html).toContain('<script type="application/json" id="attention">[]</script>');
  });

  it('renders the enable alerts button hidden', () => {
    expect(renderBoard(board([]))).toMatch(/<button[^>]*id="enable-alerts"[^>]* hidden[^>]*>Enable alerts<\/button>/);
  });

  it('initializes attention silently and sets the title count on page load', () => {
    const page = livePage([task(1, 'review')]);
    expect(page.Notification).not.toHaveBeenCalled();
    expect(page.setTitle).toHaveBeenLastCalledWith('(1) Switchboard');
    expect(livePage().document.title).toBe('Switchboard');
  });

  it('alerts once for a new attention id and stays silent for unchanged ids', async () => {
    const page = livePage([task(1, 'review')]);
    page.snapshot([task(1, 'review'), task(2, 'needs_human')]);
    await page.refresh();
    expect(page.Notification).toHaveBeenCalledTimes(1);
    expect(page.Notification).toHaveBeenCalledWith('Switchboard: #2 needs you', {
      body: 'Card 2 (needs_human)', tag: 'sb-attn-2',
    });
    expect(page.document.title).toBe('(2) Switchboard');
    await page.refresh();
    page.snapshot([task(2, 'review'), { ...task(1, 'needs_human'), title: 'Updated title' }]);
    await page.refresh();
    expect(page.Notification).toHaveBeenCalledTimes(1);
  });

  it('rebuilds attention ids so leaving clears the count and reentry alerts again', async () => {
    const page = livePage([task(1, 'review')]);
    page.snapshot([]);
    await page.refresh();
    expect(page.document.title).toBe('Switchboard');
    page.snapshot([task(1, 'needs_human')]);
    await page.refresh();
    expect(page.Notification).toHaveBeenCalledTimes(1);
    expect(page.Notification).toHaveBeenCalledWith('Switchboard: #1 needs you', {
      body: 'Card 1 (needs_human)', tag: 'sb-attn-1',
    });
  });

  it('keeps known ids silent during unrelated events and reconnects', async () => {
    const page = livePage([task(1, 'review')]);
    for (const kind of ['output', 'usage', 'comment_added']) {
      page.es.onmessage({ data: JSON.stringify({ kind, taskId: 1 }) });
      page.snapshot([task(1, 'review')], page.context.setTimeout.mock.calls.length);
      await page.context.setTimeout.mock.lastCall![0]();
    }
    page.context.setTimeout.mockClear();
    for (const bootId of ['first', 'first', 'second']) {
      page.es.onmessage({ data: JSON.stringify({ kind: 'hello', bootId }) });
    }
    expect(page.context.setTimeout).not.toHaveBeenCalled();
    expect(page.context.location.reload).toHaveBeenCalledTimes(1);
    page.es.onopen();
    await page.context.setTimeout.mock.lastCall![0]();
    expect(page.Notification).not.toHaveBeenCalled();
  });

  it('updates the title without notifying when permission is denied', async () => {
    const page = livePage([], 'denied');
    page.snapshot([task(1, 'review')]);
    await page.refresh();
    expect(page.document.title).toBe('(1) Switchboard');
    expect(page.Notification).not.toHaveBeenCalled();
  });

  it.each(['default', 'granted', 'denied', 'unsupported'] as const)(
    'shows enable alerts only for supported default permission: %s', async permission => {
      const page = livePage([], permission);
      expect(page.alertsButton.hidden).toBe(permission !== 'default');
      page.snapshot([task(1, 'review')]);
      await page.refresh();
      expect(page.alertsButton.hidden).toBe(permission !== 'default');
      expect(page.document.title).toBe('(1) Switchboard');
      expect(page.Notification).toHaveBeenCalledTimes(permission === 'granted' ? 1 : 0);
    },
  );

  it.each(['granted', 'denied', 'default'] as const)('updates the alert button after requesting permission: %s', async permission => {
    const page = livePage([], 'default');
    page.Notification.requestPermission.mockImplementation(async () => {
      page.Notification.permission = permission;
      return permission;
    });
    await page.enableAlerts();
    expect(page.Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(page.alertsButton.hidden).toBe(permission !== 'default');
    expect(page.Notification).not.toHaveBeenCalled();
  });
});

describe('dispatch header', () => {
  it('renders a sign out form only for an authenticated board', () => {
    const html = renderBoard({ ...board([]), authenticated: true });
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/logout"[^>]*>/);
    expect(html).toContain('Sign out</button>');
  });

  it('omits sign out when authentication is false or unspecified', () => {
    for (const data of [board([]), { ...board([]), authenticated: false }]) {
      expect(renderBoard(data)).not.toContain('action="/logout"');
      expect(renderBoard(data)).not.toContain('Sign out</button>');
    }
  });

  it('shows the draining banner and disables resume while draining', () => {
    const html = renderBoard({ ...board([]), paused: true, draining: true });
    expect(html).toContain('Dispatch is draining — the host stops when running jobs finish.');
    expect(html).toContain('<button disabled>Draining…</button>');
    expect(html).not.toContain('Resume dispatch');
    expect(html).not.toContain('Dispatch is paused — agents will not be launched.');
  });

  it('keeps the paused banner and resume control when not draining', () => {
    const html = renderBoard({ ...board([]), paused: true });
    expect(html).toContain('Dispatch is paused — agents will not be launched.');
    expect(html).toContain('Resume dispatch');
    expect(html).not.toContain('Dispatch is draining');
    expect(html).not.toContain('Draining…');
  });

  it('omits the draining banner and keeps pause available during normal dispatch', () => {
    const html = renderBoard(board([]));
    expect(html).toContain('Pause dispatch');
    expect(html).not.toContain('Dispatch is draining');
    expect(html).not.toContain('Draining…');
  });
});

describe('brain badges', () => {
  it.each([
    { model: 'custom<&>', effort: 'high', label: 'custom&lt;&amp;&gt; · high' },
    { model: 'custom<&>', effort: null, label: 'custom&lt;&amp;&gt;' },
    { model: null, effort: 'high', label: 'high' },
  ])('renders the available card brain settings: $label', ({ model, effort, label }) => {
    const html = renderBoard(board([{ ...task(1, 'ready'), model, effort }]));
    const card = html.match(/<a class="card"[^>]*>([\s\S]*?)<\/a>/)![1];
    expect(card).toContain(`<span class="badge brain">${label}</span>`);
    expect(html).toContain('.badge.brain {');
  });

  it('omits the card brain badge without overrides', () => {
    expect(renderBoard(board([task(1, 'ready')]))).not.toContain('class="badge brain"');
  });

  it('includes task model overrides in running badges and keeps the fallback label', () => {
    const html = renderBoard({
      ...board([{ ...task(1, 'in_progress'), model: 'custom<&>' }, task(2, 'in_progress')]),
      activeRuns: [1, 2, 3].map(taskId => ({ taskId, runId: taskId, agent: 'codex' })),
    });
    expect(html).toContain('<span class="badge run">codex/custom&lt;&amp;&gt; running #1</span>');
    expect(html).toContain('<span class="badge run">codex running #2</span>');
    expect(html).toContain('<span class="badge run">codex running #3</span>');
  });

  it('shows the task brain badge beside the assignee and preserves the other metadata', () => {
    const t = { ...task(1, 'review'), model: 'custom<&>', effort: 'high', bounce_count: 2 };
    const b = { ...board([t]), deps: { 1: { on: [2], unmet: [2] } } };
    const html = renderTask({ task: t, project: b.projects[0], comments: [], runs: [] }, b);
    const heading = html.match(/<h2>#1([\s\S]*?)<\/h2>/)![1];
    expect(heading).toMatch(/<span class="badge codex">codex<\/span>\s*<span class="badge brain">custom&lt;&amp;&gt; · high<\/span>/);
    expect(html).not.toContain('brain:');
    expect(html).toContain('created by human · bounces 2 · dir Z:/proj · depends on <a href="/task/2">#2</a> (waiting: #2)');
  });

  it('omits the task brain badge without overrides', () => {
    const t = task(1, 'review');
    const b = board([t]);
    expect(renderTask({ task: t, project: b.projects[0], comments: [], runs: [] }, b)).not.toContain('class="badge brain"');
  });
});

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
  it('handles hello events and reloads when the host boot changes', () => {
    const html = renderBoard(board([]));
    expect(html).toContain("kind === 'hello'");
    expect(html).toContain('location.reload()');
  });

  it('suppresses hello refreshes and reloads only for a changed non-empty bootId', () => {
    const html = renderBoard(board([]));
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('new EventSource'))![1];
    const es = { onmessage: (_event: { data: string }) => {}, onopen: () => {} };
    const reload = vi.fn();
    const setTimeout = vi.fn();
    runInNewContext(script, {
      EventSource: function () { return es; },
      document: { querySelectorAll: () => [], getElementById: () => null },
      location: { pathname: '/', reload },
      sessionStorage: { getItem: () => null },
      setTimeout, clearTimeout: vi.fn(),
    });
    const send = (bootId: string) => es.onmessage({ data: JSON.stringify({ kind: 'hello', bootId }) });
    send('first');
    send('first');
    send('');
    expect(reload).not.toHaveBeenCalled();
    expect(setTimeout).not.toHaveBeenCalled();
    send('second');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(setTimeout).not.toHaveBeenCalled();
    es.onmessage({ data: JSON.stringify({ kind: 'status_changed', taskId: 1 }) });
    expect(setTimeout).toHaveBeenCalledTimes(1);
    es.onopen();
    expect(setTimeout).toHaveBeenCalledTimes(2);
  });

  it('keeps a pending client_id and generates it with getRandomValues', () => {
    const html = renderBoard(board([]));
    const script = html.slice(html.indexOf('<script>'));
    expect(script).toContain('form.dataset.clientId ??= newId()');
    expect(script).toContain('getRandomValues(new Uint8Array(16))');
    expect(script).toContain('client_id: form.dataset.clientId');
    expect(script).toContain('if (ok === true || ok === 409) delete form.dataset.clientId');
    expect(script).not.toContain('randomUUID');
  });

  it('never clears hidden inputs when resetting a submitted form', () => {
    const html = renderBoard(board([]));
    // The tuning rows carry <input type="hidden" name="agent">; wiping it broke the second Apply.
    expect(html).toContain('input:not([type="checkbox"]):not([type="hidden"])');
  });

  it('refreshes on every SSE open including the first', () => {
    const html = renderBoard(board([]));
    expect(html).toContain('es.onopen = scheduleRefresh');
    expect(html).not.toContain('if (connected)');
  });

  it('only polls output on task pages', () => {
    const html = renderBoard(board([]));
    expect(html).toContain("if (location.pathname.startsWith('/task/')) pollOutput();");
  });
});

describe('form request outcomes', () => {
  function formPage(status: number) {
    const page = livePage();
    const button = { disabled: false };
    const draft = { value: 'Original draft' };
    const hidden = { value: 'human' };
    const form = {
      dataset: {} as { clientId?: string },
      querySelector: () => null,
      querySelectorAll: (selector: string) => selector === 'button[type="submit"]' ? [button]
        : selector.includes(':not([type="hidden"])') ? [draft] : [draft, hidden],
    };
    const alert = vi.fn();
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(getRandomValues.mock.calls.length));
    const context = Object.assign(page.context, {
      alert, crypto: { getRandomValues },
      FormData: function () { return { entries: () => [['body', draft.value], ['author', hidden.value]] }; },
      event: { preventDefault: vi.fn(), target: form },
    });
    const getPage = page.fetch.getMockImplementation()!;
    page.fetch.mockImplementation(async (path, options) => options?.method === 'POST'
      ? { ok: status === 200, status, text: async () => 'Request failed' }
      : getPage(path, options));
    return {
      ...page, context, button, draft, hidden, form, alert,
      submit: () => runInNewContext("submitForm(event, '/api/tasks/1/comment')", context),
    };
  }

  it.each([409, 500])('returns the numeric failure status and refreshes only a conflict: %i', async status => {
    const page = formPage(status);
    expect(await runInNewContext("api('/api/tasks/1/comment', {})", page.context)).toBe(status);
    expect(page.alert).toHaveBeenCalledWith('Request failed');
    expect(page.fetch.mock.calls.filter(([, options]) => options?.method !== 'POST')).toHaveLength(status === 409 ? 1 : 0);
  });

  it.each([409, 500, 200])('handles client ids, drafts, and button state after response %i', async status => {
    const page = formPage(status);
    expect(page.submit()).toBe(false);
    expect(page.context.event.preventDefault).toHaveBeenCalledTimes(1);
    expect(page.button.disabled).toBe(true);
    const firstId = page.form.dataset.clientId;
    expect(firstId).toMatch(/^[a-f0-9]{32}$/);
    await vi.waitFor(() => expect(page.button.disabled).toBe(false));
    expect(page.form.dataset.clientId).toBe(status === 500 ? firstId : undefined);
    expect(page.draft.value).toBe(status === 200 ? '' : 'Original draft');
    expect(page.hidden.value).toBe('human');
    expect(page.alert).toHaveBeenCalledTimes(status === 200 ? 0 : 1);
    page.draft.value = 'Next draft';
    page.submit();
    const posts = page.fetch.mock.calls.filter(([, options]) => options?.method === 'POST');
    const secondId = JSON.parse(posts[1][1]!.body!).client_id;
    if (status === 500) expect(secondId).toBe(firstId);
    else expect(secondId).not.toBe(firstId);
    await vi.waitFor(() => expect(page.button.disabled).toBe(false));
  });

  it('preserves a draft edited while a successful request is pending', async () => {
    const page = formPage(200);
    page.submit();
    page.draft.value = 'New draft during submission';
    await vi.waitFor(() => expect(page.button.disabled).toBe(false));
    expect(page.draft.value).toBe('New draft during submission');
    expect(page.form.dataset.clientId).toBeUndefined();
  });

  it('preserves the pending id and draft after a network failure', async () => {
    const page = formPage(200);
    page.fetch.mockRejectedValueOnce(new Error('offline'));
    page.submit();
    const pendingId = page.form.dataset.clientId;
    await vi.waitFor(() => expect(page.button.disabled).toBe(false));
    expect(page.form.dataset.clientId).toBe(pendingId);
    expect(page.draft.value).toBe('Original draft');
    expect(page.alert).toHaveBeenCalledWith('Could not reach Switchboard. Your draft is preserved.');
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

  it('submits expected_status from the status select dataset.rendered', () => {
    const html = renderTask(data('in_progress'), board([task(1, 'in_progress')]));
    expect(html).toContain('select[name="status"][data-rendered]');
    expect(html).toContain('body.expected_status = statusSelect.dataset.rendered');
  });

  it('refreshes the page after alerting a status conflict', () => {
    const html = renderTask(data('in_progress'), board([task(1, 'in_progress')]));
    expect(html).toContain('if (res.status === 409) await refreshPage()');
  });
});
