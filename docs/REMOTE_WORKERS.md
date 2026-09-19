# Run Switchboard tasks on another PC

The board stays on one computer. Workers make outbound HTTP connections, claim tasks
addressed to their worker ID, run a local Claude Code or Codex CLI, and send output and
completion back. No remote shell service or inbound worker firewall rule is required.
The board UI and existing human/admin API listen on port 4680 on the LAN, preserving mobile browser access. A separate authenticated listener serves workers.

## Board configuration

Add this to `switchboard.config.json`:

```json
{
  "remote": {
    "host": "0.0.0.0",
    "port": 4781,
    "tokenEnv": { "worker-one": "SWITCHBOARD_WORKER_ONE_TOKEN" }
  }
}
```

Set `SWITCHBOARD_WORKER_ONE_TOKEN` in the board environment or its ignored `.env` file to a
random secret of at least 32 characters. Each worker must have its own secret. Restart
the board to load this configuration. Allow TCP 4781 from the worker's IP in the board
PC's firewall. Use this HTTP configuration on a trusted LAN; use HTTPS via a reverse
proxy or a private VPN for other networks. Keep the unauthenticated board port 4680 on the trusted LAN; do not forward it to the public internet.

If a listed variable is missing or shorter than 32 characters, the board still starts: it logs a
warning and shows that PC as **setup needed**.

## Worker installation

Copy this repository to the worker PC (source and package files, without the board's
`.env`, `data`, database, credentials, or `node_modules`). Install Node.js 22+ and the
desired authenticated CLI, then run `npm ci`.

Copy `worker.config.example.json` to `worker.config.json`. Configure the board URL,
worker ID, supported agents, and project mappings. Every mapped directory must already
exist, and paths belong to this worker PC. Project names must match registered board
projects; the board's own path is not sent as a work directory. Remote-only projects can
use an empty placeholder directory on the board host when registered.

```powershell
$env:SWITCHBOARD_WORKER_TOKEN = '<the matching worker secret>'
npm run worker -- worker.config.json
```

The smoke installer stores the secret using Windows DPAPI for the current user.
`powershell -ExecutionPolicy Bypass -File .\Start-Worker.ps1` restarts that installation.
Regular manual installations can instead set the environment variable themselves.

Create a task in the board UI and choose the machine in **Run on PC**. The MCP
`create_task` tool and `/api/tasks` also accept `worker_id`. Omit it for local execution.
`create_task` rejects worker ids that are not configured, and remote tasks may only be assigned to
claude or codex; other agents run on the board host.
The board labels remote cards with their target PC. Run output and comments appear in
the normal task view. Each worker runs one task at a time; additional PCs run concurrently.

Claude receives a per-run MCP configuration; Codex receives per-run configuration overrides
and its scoped token through an environment variable. Global CLI configuration is not
rewritten. Codex's supported HTTP bearer-token configuration is documented in the
[official MCP documentation](https://developers.openai.com/codex/mcp/).
The scoped MCP connection supports `get_task`, `add_comment`, `finish_task`, and
`update_status` to `needs_human`, only for the leased task. The supervisor releases the
task after the CLI exits, so an early `finish_task` cannot release a dependency.

## Files and dependencies

Workers operate directly in their configured local directories; remote worktree merging,
automatic Git fetch/push, and file transfer are not implemented. Use dedicated worker
checkouts and avoid concurrent manual edits. File paths in reports refer to that PC.

Same-worker dependencies unblock at `review` as usual. Dependencies crossing between
PCs (including the board host) require the prerequisite to reach `done`: transfer the
required commits/files and verify the receiving checkout first, then mark the prerequisite
done. The scheduler cannot verify that transfer itself. This prevents silently treating
another PC's untransferred work as locally available.

## Disconnects and recovery

Leases last 60 seconds and renew via heartbeats. Lost workers are parked in `needs_human`,
never automatically reassigned. Late results cannot complete expired leases. Completion
retries are idempotent. Leases survive board restarts; local orphan recovery leaves them
to the remote coordinator.

On sustained connection loss the worker requests CLI process-tree termination and waits
for it to exit before accepting more work. The worker's `data/worker-ID/worker.lock`
prevents two processes in the same installation. After a crash, check and stop surviving
CLI processes, recover files, then remove that exact lock file before restarting. Never
run duplicate installations with the same worker ID. If Windows refuses process
termination, the worker may remain waiting; inspect that PC rather than retrying the task.

## PC dropdown

The `machines` array in `switchboard.config.json` holds display names, LAN IPs, and stable
`workerId` values. the host uses `workerId: null` for local execution. Remote entries
without a configured credential are shown as disabled **setup needed** options.
**Registered** means a worker credential is configured, not that the PC is online or its
CLIs/projects are ready. IPs are display metadata; routing still uses the authenticated
worker ID. Add credentials and restart the board when onboarding each PC.
