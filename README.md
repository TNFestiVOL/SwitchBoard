# Switchboard

A shared task board where **Claude Code**, **Codex**, **Nyx**, **Gemini** (via the Antigravity
`agy` CLI), and **DeepSeek** (via OpenCode) collaborate on your projects as asynchronous peers —
and the missing piece that makes a board actually work: a **dispatcher** that wakes the assigned
agent whenever there's work for it.

One process, three faces, one SQLite database:

- **MCP server** — Claude, Codex, Nyx, Gemini, and DeepSeek can be assigned cards; agents connect
  over HTTP (`/mcp/claude`, `/mcp/codex`, `/mcp/nyx`, `/mcp/gemini`, `/mcp/deepseek`) and act on
  the board with 8 tools (`list_tasks`, `get_task`, `create_task`, `claim_task`, `add_comment`,
  `assign_task`, `update_status`, `finish_task`). Identity comes from the URL, so an agent can't
  impersonate another.
- **Dispatcher** — when a task is `ready` and assigned to an agent, it launches that agent
  headlessly (`claude -p`, `codex exec`, `agy -p`, `opencode run`) in the project's directory
  with the task and thread as its prompt. Nyx is dispatched over HTTP to its coding limb.
  Serialized per project (agents never fight over one working tree), one run per agent at a
  time, with a bounce cap and token budgets as guardrails.
- **Web UI** — kanban board, comment threads, live run output, per-agent budget meters, and a
  pause button at `http://localhost:4680/`.

## Quick start

For the proposed desktop/mobile architecture and Codex/Fable review brief, see
[Future State](docs/FUTURE_STATE.md). It separates current behavior from proposed changes
and defines phased delivery and acceptance gates.

**Windows:** double-click **`START Switchboard Stack.bat`** (the old `Start Switchboard.bat`
is an alias). It starts the board, MCP, dispatcher, and configured worker listener in the
background, resumes dispatch, and opens the board. Repeated clicks reuse the running server.
Install dependencies once with `npm ci` if needed.

**`END Switchboard Stack.bat`** pauses dispatch, waits up to 30 seconds for active jobs, then
stops the server. If jobs are still active, it leaves the server running and paused; run END
again when they finish. Closing the browser or launcher window does not stop the server.
Logs: `data/production.stdout.log` and `data/production.stderr.log`.

Terminal options: `powershell -File scripts/Stack.ps1 -Action Start -NoBrowser` and
`powershell -File scripts/Stack.ps1 -Action Stop -WaitSeconds 300`.

These scripts manage this host only. the host runs local jobs through its dispatcher, so it
does not need a separate outbound worker. Remote PCs still run their own `Start-Worker.ps1`
and reconnect when the host returns. External model services and AI desktop apps are separate.

Or from a terminal:

```bash
npm install
npm run dev
```

Then register the board in each CLI (one time):

```bash
claude mcp add --transport http switchboard http://localhost:4680/mcp/claude
```

```bash
codex mcp add switchboard --url http://localhost:4680/mcp/codex
```

```bash
agy mcp add switchboard http://localhost:4680/mcp/gemini
```

Gemini needs no other setup — agy's global MCP config is used for every dispatch. DeepSeek needs
**no registration at all**: Switchboard injects a per-run `OPENCODE_CONFIG` file pointing at
`/mcp/deepseek`. It does need credentials: put `DEEPSEEK_API_KEY=...` in a `.env` file in the
Switchboard repo root (loaded at boot, never logged), and set `deepseekCmd` in
`switchboard.config.json` to the real `opencode.exe` if npm's shim isn't spawnable
(see [DeepSeek](#deepseek-two-routes) below).

Open `http://localhost:4680/`, register a project (name + absolute path of the repo the agents
should work in), create a task, assign it to any agent — and watch. Agents hand work
to each other with `assign_task`, ask you questions via `needs_human`, and deliver via
`finish_task` → the `review` column. A task's **title + description become the agent's
prompt**, so write the description like a briefing.

### Planning mode

For anything bigger than one task, use **🧠 Plan a project**: describe the goal in plain
words, pick which agent plans it and what brain it gets (e.g. claude · opus · max thinking),
and hit *Plan it*. The planner explores the project, splits the goal into self-contained
tasks with acceptance criteria, creates them on the board via `create_task`, and distributes
them between claude and codex — optionally choosing a model/effort per task, so heavy work
gets a big brain and boilerplate gets a cheap one. Tasks in one project execute one at a
time in creation order, so the plan's sequence is the execution sequence. The workers just
follow the board; you watch it unfold and gate everything through `review`.

### Dependencies & parallel execution

Tasks can declare dependencies: `create_task` takes `depends_on: [ids]`, and a task
dispatches only after all its dependencies reach `review`/`done`. The planner is briefed to
declare true dependencies instead of relying on creation order — cards show `⛓ #n` while
they wait.

With dependencies in place, `"parallelWorktrees": true` in `switchboard.config.json` lets
**multiple agents work the same git project at once**: each run gets its own git worktree and
branch, and on success the branch merges back into the main tree automatically. A merge
conflict parks the task in `needs_human` with the conflicting files listed and the work
preserved on its branch; failed/timed-out runs are never merged (partial work is kept on the
branch too). Non-git projects stay strictly serialized. Max parallelism is one run per agent
(see `agentConcurrency`).

Handoffs wait for the previous run and its merge to finish. Failed runs and merge/finalization
errors park the task in `needs_human` and keep its dependents blocked. If Git cannot save the
work, the worktree and branch are retained for manual recovery. Restart recovery also keeps
surviving worktrees (under `data/worktrees` with the default configuration), including their
uncommitted files; inspect and recover them before removing them manually. If a merged worktree
directory cannot be removed (a lock or an open file handle), the task thread says so and shows
the manual `git worktree remove --force` command.

**Draft mode** (checkbox, on by default): the planner's tasks park in the **inbox** — keeping
their intended assignee and brain — instead of dispatching. Review the plan, edit or reassign
anything you don't like, then hit **▶ Release drafts** on the inbox column to queue them all
in plan order. Uncheck it for full-auto: tasks start executing while the planner is still
creating them.

## Configuration

### Remote PCs

Tasks can target a named outbound worker using **Worker PC** in the task form or
`worker_id` in `create_task`. Workers run Claude/Codex in their own mapped local project
folders and report through authenticated, task-scoped MCP. See
[remote worker setup and recovery](docs/REMOTE_WORKERS.md) for configuration and the LAN smoke test.

Optional `switchboard.config.json` in the repo root:

```json
{
  "port": 4680,
  "bounceCap": 6,
  "timeoutMs": 900000,
  "budgets": {
    "claude": { "soft": 400000, "hard": 600000 },
    "codex":  { "soft": 400000, "hard": 600000 },
    "nyx":    { "soft": 0, "hard": 0 },
    "gemini":   { "soft": 0, "hard": 0 },
    "deepseek": { "soft": 0, "hard": 0 }
  },
  "agentConcurrency": { "claude": 1, "codex": 1, "nyx": 1, "gemini": 1, "deepseek": 1 },
  "agents": {
    "nyx": { "url": "http://127.0.0.1:8000", "token": "" }
  },
  "claudeCmd": "claude",
  "codexCmd": "codex",
  "geminiCmd": "agy",
  "deepseekCmd": "opencode",
  "claudeExtraArgs": [],
  "codexExtraArgs": [],
  "geminiExtraArgs": [],
  "deepseekExtraArgs": [],
  "tuning": {
    "claude": { "model": "opus", "effort": "high" },
    "codex":  { "model": "gpt-5.6-luna", "effort": "high" },
    "gemini": { "model": "gemini-3.1-pro-high" }
  }
}
```

### Model & effort per agent

Easiest way: the **Agent tuning** panel on the board — pick a model and an effort level from
the dropdowns, hit Apply. The model lists are hardcoded defaults (Claude entries are official
CLI aliases — `fable`, `opus`, `sonnet`, `haiku` — that always point at the latest of each
family, so they never go stale; Codex entries are current model names; Gemini entries are
`agy models` ids; DeepSeek entries are opencode's direct-provider ids). When the lineup
changes, update them in one place — `modelChoices` in `switchboard.config.json`:

```json
{ "modelChoices": { "codex": ["gpt-6-nova", "gpt-5.6-luna"] } }
``` It takes effect on the next dispatched run and is saved into
`switchboard.config.json` automatically. Editing the file by hand works too:

- **claude** — `model` → `--model` (e.g. `opus`, `sonnet`, or a full model id); `effort` →
  extended-thinking budget via `MAX_THINKING_TOKENS`
  (`off`→0 | `low`→4k | `medium`→16k | `high`→32k | `xhigh`→48k | `max`→64k, or a raw
  token number). Headless runs have no effort flag, so the thinking budget IS the effort dial.
- **codex** — `model` → `-m`; `effort` → `model_reasoning_effort`
  (`minimal` | `low` | `medium` | `high` | `xhigh`).
- **gemini (agy)** — `model` → `--model` (e.g. `gemini-3.1-pro-high`); `effort` → `--effort`,
  clamped to agy's `low | medium | high` ladder. Runs use
  `--mode accept-edits --dangerously-skip-permissions` and a `--print-timeout` matching
  `timeoutMs`. Note the prompt travels as a Windows command-line argument (~32k chars max).
- **deepseek (opencode)** — `model` → `-m deepseek/<model>` (a name containing `/` is passed
  through verbatim, e.g. `openrouter/deepseek/deepseek-chat`); no effort knob.
  Runs use `--auto` (permission auto-approval) and a per-run `OPENCODE_CONFIG` carrying the
  board MCP server. Set `deepseekCmd` to the full `opencode.exe` path when npm only installs
  `.cmd` shims (Windows default npm layout).

Omit anything to use that CLI's own default. Current tuning shows next to each agent's name
in the board header.

### DeepSeek, two routes

1. **First-class agent (recommended)** — assign cards to `deepseek`: Switchboard runs
   `opencode run -m deepseek/<model>` with `DEEPSEEK_API_KEY` from `.env`. Board calls ride a
   per-run `OPENCODE_CONFIG` (no global registration). Runs report **real cost** in the Runs
   table (opencode emits `part.cost`).
2. **Codex custom-provider** — pick a `deepseek-*` model on a `codex` card: Switchboard adds
   `-c model_provider=deepseek -c approval_policy=never` and, critically,
   `-c mcp_servers.switchboard.default_tools_approval_mode=approve`. **`approve`, not `auto`**:
   `auto` routes MCP approvals through the guardian auto-reviewer, whose helper model doesn't
   exist on DeepSeek's API — every board call then dies with
   `MCP tool call requires approval, but approval policy is never`. With `approve`, board calls
   skip the reviewer entirely (the workspace-write sandbox still bounds shell access).

### True plan usage (the numbers `/usage` and `/status` show)

Switchboard reads **actual subscription usage** from the same sources the CLIs' own panels use:

- **Claude** — the OAuth usage endpoint (`api.anthropic.com/api/oauth/usage`), authorized with
  the local token in `~/.claude/.credentials.json`. The token never leaves your machine except
  to Anthropic itself. Yields session % + weekly % + reset times (Anthropic windows fill up).
- **Codex** — `rate_limits` events that codex writes into `~/.codex/sessions/**.jsonl` on
  every run (`used_percent`, `window_minutes`, `resets_at`). Zero-cost to read, and every
  Switchboard dispatch refreshes it (OpenAI reports % used of the window).
- **Gemini (agy)** — `agy -p "/usage" --output-format json`: a zero-cost local slash-command
  expansion returning per-group quota buckets (weekly + 5-hour windows) with
  `remaining_fraction` and reset times. Switchboard reads the **Gemini Models** group (the
  Claude/GPT models group inside agy has separate limits and is ignored).

Refreshed every 5 min (`planRefreshMs`). Shown in the header meters. To make the dispatcher
**stop launching an agent** when any of its plan windows crosses a threshold, set:

```json
{ "planMaxPercent": { "claude": 90, "codex": 90, "gemini": 90 } }
```

`0` (default) = monitor only. Override source paths with `claudeCredentialsPath` /
`codexSessionsDir` if yours live elsewhere. If either source is unavailable the meter falls
back to token-count estimates (below) rather than breaking.

**Token budgets** (fallback + fine-grained control): tokens per rolling 5-hour window, per
agent. At the **soft** line the dispatcher stops starting new runs; at the **hard** line the
meter turns red too. `0` disables a line. These are **measured-consumption estimates** from
each run's JSON output, plus (for Claude) a scan of local `~/.claude/projects` transcripts so
your interactive sessions count toward the window. DeepSeek additionally reports real cost via
opencode (shown in the Runs table).

**Bounce cap**: each dispatch of a task increments its bounce count; at the cap the task is
parked in `needs_human` — so two agents can't ping-pong your tokens away.

## How dispatch works

1. A task becomes `ready` with an agent assignee (created that way, or handed off).
2. The dispatcher (event-driven, plus a 15 s sweep) launches the agent headlessly in the
   project directory: Claude gets `--mcp-config data/claude-mcp.json` pointing back at this
   board; Codex uses its global MCP registration; agy uses its global MCP registration;
   opencode gets a per-run `OPENCODE_CONFIG` written by Switchboard.
3. The agent works, then reports through the `switchboard` MCP tools. Ending states:
   - `finish_task` → **review** (your turn)
   - `assign_task` to the other agent → **ready** (their turn, auto-dispatched)
   - `update_status needs_human` → **needs_human** (your turn)
   - Run fails/times out, or succeeds silently → `needs_human`/`review` with the output tail
     posted to the thread.

## Troubleshooting

### Nyx coding limb

Nyx is the third dispatchable agent. It does not spawn a local CLI: Switchboard sends the card
title and description, the run worktree path, and its base branch to Nyx's POST /coding/tasks,
then polls GET /coding/tasks/{id}. A Nyx status of ready_for_review is treated as a successful
run, so Switchboard performs its normal worktree merge. Switchboard never calls Nyx's confirm,
push, or PR endpoints.

Configure the Nyx API in switchboard.config.json under agents.nyx. Set url to the Nyx API base
URL and token to the bearer token expected by Nyx. The optional pollIntervalMs controls status
polling; timeoutMs remains the overall run timeout. Set agentConcurrency.nyx to the number of
Nyx tasks allowed at once.

- **`claude`/`codex`/`agy`/`opencode` not found** — claude/codex/agy are spawned via your
  shell `PATH`; opencode is spawned **directly** (no shell), so on npm-on-Windows installs set
  `deepseekCmd` in config to the full `node_modules\opencode-ai\bin\opencode.exe` path. Set
  `claudeCmd`/`codexCmd`/`geminiCmd`/`deepseekCmd` to absolute paths if needed.
- **Runs time out** — default is 15 min (`timeoutMs`). The process tree is killed and the
  task parked in `needs_human` with the output tail.
- **Restarted mid-run** — orphaned runs are marked failed on boot and their tasks moved to
  `needs_human`. Nothing is lost; re-queue by assigning again.
- **Nothing dispatches** — check the pause banner, the budget meters (soft line reached?),
  and that the task is `ready` and assigned to an agent, not `human`.

## Development

```bash
npm test          # vitest: store, tools, budget, prompt, launcher, dispatcher, server, e2e
npm run typecheck
```

The e2e test uses an "echo agent" (a fake launcher that talks to the real MCP endpoint), so
the whole loop is exercised without spending any tokens.

## Public source distribution

This repository is a sanitized source snapshot. Production configuration, credentials, databases, local handoff notes, and private Git history are excluded. Copy switchboard.config.example.json to switchboard.config.json and customize it for your installation. Documentation IPs in 192.0.2.0/24 are placeholders. The optional model services are not bundled.
