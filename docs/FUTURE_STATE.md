# Switchboard Future State

Status: proposal for Codex + Fable review, not an implementation commitment.
Date: 2026-09-19. Source checkout: `<checkout>`.
Owner: the operator. Primary host: the host (`192.0.2.10`).

## 1. Outcome and agreed boundaries

Build installed desktop and mobile clients around a shared Switchboard interface. the host remains the authoritative server: database, task graph, scheduler, MCP, worker coordination, and execution records. Clients connect to it; closing a client never shuts it down. Desktop means Windows first; macOS/Linux are optional targets to confirm. Mobile means Android and iOS.

The service is LAN-first. the host is expected to be awake and reachable most of the time. An unavailable the host produces an honest offline screen and preserved drafts, not a second scheduler or an independent copy of the board. Wake-on-LAN/WoWL is an optional recovery path, not high availability. No cloud hosting or internet-facing board is required.

The first delivery should reuse the existing UI and execution behavior. Native packaging does not require a new backend, a database migration away from SQLite, or a redesign of the scheduler.

## 2. Current implementation, verified from source

| Area | Current behavior | Consequence for the plan |
|---|---|---|
| Host | `src/index.ts` starts Express board/MCP on 4680, configured worker listener on 4781, dispatcher and SQLite store | Keep one authoritative host; separate modules before considering separate services |
| UI | `src/ui.ts` renders HTML and embedded scripts; SSE triggers fragment updates; output has separate polling | No full reload needed today, but packaged assets/API separation is still work |
| Client API | `src/server.ts`: `/api/state`, mutations, output endpoint, HTML task details | Add explicit task-detail JSON and a versioned client contract |
| Events | `src/events.ts` is an in-memory emitter; SSE has no persistent cursor/replay | Reconnection must resnapshot until durable event support exists |
| Identity | Human/admin API is unauthenticated on the trusted LAN; general MCP identity comes from URL | A URL actor label is not authenticated identity; preserve current deployment while planning explicit pairing |
| Workers | `src/remote.ts`, `src/worker.ts`, `src/worker-cli.ts`: distinct worker credentials, task-scoped leases, heartbeats, bounded output, completion | Preserve these boundaries and lease recovery behavior |
| Execution | Fixed agent list; remote agents currently Claude and Codex; local providers include Nyx, Gemini, DeepSeek | Seven local models and GLM are future capabilities, not current support claims |
| Files | Remote workers use mapped local folders; automatic cross-PC Git/file transfer absent | A completed run does not prove another PC has its changes |
| Host controls | `scripts/Stack.ps1` plus START/END batch launchers start/reuse and drain the host | Useful bootstrap; not yet a Windows service/supervisor |
| Machines | Config has human names, IPs and worker IDs; credential configuration determines availability in dropdown | Registered is not online or ready |

Source references: `src/types.ts`, `src/store.ts`, `src/dispatcher.ts`, `src/server.ts`, `src/ui.ts`, `src/remote.ts`, `docs/REMOTE_WORKERS.md`, `scripts/Stack.ps1`. This is a source-level architecture inventory, not a fresh operational audit of every machine.

Example topology: one host and several independently provisioned workers. Installation, authentication and project readiness must be measured, never inferred from this list.

## 3. Target topology

```mermaid
flowchart TB
  Browser[LAN browser] --> Host
  Desktop[Windows desktop client] --> Host
  Mobile[iOS / Android client] --> Host
  Host[the host: API + MCP + event stream]
  Host --> DB[(SQLite: authoritative state)]
  Host --> Scheduler[Scheduler and run coordinator]
  Scheduler --> Local[the host execution adapters]
  Remote[Remote workers: outbound claims and heartbeats] --> Host
  Remote --> Workspaces[Worker-local checkouts and model / CLI adapters]
  HostControl[the host-only local supervisor] --> Host
  Wake[Optional independent wake sender] -. wake packet .-> the host[the host hardware]
```

UI clients receive task state and submit intentions; they do not execute arbitrary commands. Worker execution and model serving are separate capabilities even when they live on one PC. For example, a PC hosting an LLM endpoint need not own the task's Git checkout.

Recommended logical modules: host runtime; scheduling/domain layer; store; human client API; general agent MCP; worker API/scoped MCP; shared UI; platform shells; local host supervisor. Keep these in this repository initially. Do not introduce microservices merely to package a window.

## 4. Packaging decision to workshop

Recommendation to prototype: Tauri desktop + Capacitor mobile, sharing web UI and API types. This is a candidate, not a selected dependency. Compare a Tauri-only approach in the same short spike; choose based on actual Windows/iPhone/Android behavior, plugin support, build tooling and maintenance burden. Electron is a desktop alternative if bundled-browser consistency outweighs footprint. Do not spend the spike building three finished clients.

| Stage | Delivery model | Tradeoff |
|---|---|---|
| Early proof | Native window loads current the host UI; local connection/settings/offline surface outside that page | Fastest proof, but remote content must not gain a general native bridge |
| Durable client | Package shared UI assets; call versioned the host API | Offline shell works without the host; adds API, origin/auth and client-version handling |
| Browser | Continue serving the shared UI from the host | Retains zero-install access and recovery route |

A permanent mobile product should not rely on Capacitor's development `server.url` setting as its architecture. Its configuration docs describe this remote-loading option as intended for live reload, not production. Prefer bundled assets for the durable client; validate a deliberately restricted plain webview only as a temporary proof. [Capacitor configuration](https://capacitorjs.com/docs/config).

Extract rendering/style/client logic from the large `src/ui.ts` template gradually; select a UI framework only if it simplifies this extraction. Avoid a simultaneous scheduler rewrite. Deliver the same task operations and visual behavior first, then improve layouts.

Desktop client requirements: single-instance behavior, task deep links, window restoration, tray optional, visible connection status. Closing the window can minimize or exit the client according to a setting; neither stops the host. the host's privileged supervisor should be a separate local component with a narrow start/status/drain-stop interface. Other clients must not obtain generic shell execution. Tauri capabilities can restrict native access by window/webview and origin; remote content should have no privileged host controls. [Tauri capabilities](https://tauri.app/security/capabilities/).

Mobile requirements: safe-area layout, keyboard-aware forms, Android Back behavior, touch targets, task links, remembered server, offline screen, foreground reconnect and durable drafts. iOS builds require the Apple toolchain; establish Mac access, signing owner and distribution method before promising an installable release. [Capacitor iOS](https://capacitorjs.com/docs/ios).

## 5. Host API and synchronization changes

Add `/api/v1` alongside existing routes; preserve old browser/MCP/worker compatibility during migration. Proposed contract:

- `GET /health/live`: process responds; `GET /health/ready`: storage and required listeners usable. Do not treat a TCP socket alone as readiness.
- `GET /api/v1/info`: stable server ID, build version, supported API range, capabilities and boot ID; no secrets.
- Task list/detail, comments, runs and paginated output; project and worker lists; authorized mutations; distinct administrative controls.
- Structured errors, request IDs, pagination, bounded payloads, consistent timestamps and documented state transitions.
- Mutation idempotency keys for create/comment/assignment retries. Persist operation result with the mutation in one transaction; key scope includes caller and operation. Reusing a key with a different body fails.
- Revision numbers for editable records. Conflicting edits return current revision and require reconciliation rather than silently overwriting another client.

First synchronization release: SSE invalidation plus snapshot refresh on connect/resume. Retain scroll/focus/drafts and coalesce bursts. A lost connection means state may be stale even if the last page is visible. Reconnect with bounded backoff/jitter; show last successful sync. Native lifecycle resume triggers an immediate refresh.

Later, if needed: transactional event outbox with monotonic IDs, replay retention, `Last-Event-ID`, and full snapshot fallback after cursor expiry. Define snapshot watermark/replay ordering so updates cannot fall between snapshot and subscription. SSE remains sufficient for server-to-client events; WebSockets are not required just because this is an app.

Native EventSource authentication is a design gate: browser EventSource cannot set arbitrary authorization headers. Choose secure cookie sessions for same-origin browser use and an authenticated fetch-stream/native transport for packaged clients, or another explicitly tested session strategy. Do not put reusable access tokens in event URLs.

Offline v1: local drafts and optionally a clearly stale last-view cache, namespaced by server ID and user. No automatic replay of task creation, assignment, release, cancel or shutdown. A timed-out mutation is an unknown outcome until checked by operation ID. Sensitive drafts must not silently travel to a newly entered server address.

## 6. Access and LAN transport

Current trusted-LAN behavior remains an explicit deployment choice; this document does not change it. For packaged clients propose pairing from the host, revocable device credentials, role separation (viewer/operator/admin), and a separate identity for each agent integration. Validate authorization on the host, not by hiding UI buttons. Retain worker-specific and lease-specific credentials; never ship the host `.env` or worker secrets inside an app.

Transport decision: prefer a stable LAN DNS name with trusted HTTPS for durable clients. Select either a managed local CA trusted on the devices or an owned domain with LAN DNS and suitable certificate provisioning; avoid assuming a public inbound port is necessary. If the initial LAN pilot stays HTTP, document a narrowly scoped platform exception and the fact that credentials are unencrypted. Do not disable certificate validation globally. Plan origin allowlists, CSRF defenses for cookies, and explicit navigation handling for external links.

Apple local-network permission needs a useful explanation and denied-permission recovery; Android transport policy needs release-build testing. Local network permission and HTTP/TLS permission are separate concerns. [Apple local-network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy), [Android network security configuration](https://developer.android.com/privacy-and-security/security-config).

## 7. Reliable host lifecycle and recovery

Promote START/END into a supervised runtime with startup-at-login/boot, crash restart backoff, log rotation, readiness, version reporting and controlled updates. Decide between a scheduled task under the current account and a Windows service only after testing CLI authentication, profile access, mapped drives and DPAPI. The current `Z:` checkout and user-bound credentials are a concrete service-migration concern. A service under another identity must not be assumed to see them.

Define stop as drain: reject new local dispatch and remote claims, keep heartbeats/results/MCP alive for existing runs, then close listeners and SQLite. Timeout leaves a visible paused/draining state. Forced termination is a separate explicit action with affected runs listed. Handle OS shutdown and startup recovery consistently. Track active, draining and stopped states instead of relying solely on process existence.

Backups: SQLite-consistent snapshots, configuration backup without broadly copying credentials, retention on another device, and a restore drill into an isolated host. Prevent the restored host from dispatching until its identity and leases are reconciled. Database migrations need versioning, backup-before-upgrade and a documented rollback/restore boundary. Never run two authoritative hosts against copied live state.

## 8. Worker fleet and model expansion

Add worker registration/status records: stable ID, display name, last seen, software/protocol version, OS, supported execution adapters, CLI readiness and configured project mappings. Distinguish offline, reachable, ready, busy, draining and setup-needed. Credentials configured does not mean signed in or healthy. Cache readiness probes with expiry; avoid invoking paid model work as a heartbeat.

Separate task choices: execution PC, executor/provider, model and effort. Replace scattered fixed enums with a validated provider/adapter registry in a later phase. Record the resolved model/configuration on each run. Advertise capabilities such as tool support, context limits, concurrency and required runtime; do not equate every OpenAI-compatible endpoint with a usable coding agent. GLM and the seven local LLMs require independent adapter and tool-contract validation.

Workers continue pulling work. Preserve lease ownership and stale-result rejection. Future fencing tokens prevent an expired worker from committing authoritative results, but cannot undo file edits it already made. Never automatically move an uncertain run to another PC until the original process/files are reconciled.

Cross-PC handoffs require explicit artifact receipts: repository identity, source commit, branch, producing run, target checkout and verification result. Start with human-approved Git transfer; add controlled fetch/apply later. Do not transfer credentials or whole working folders by default. Keep cross-machine dependencies blocked until the receiving state is proven available.

## 9. Improvements by priority

| Priority | Improvement | Acceptance evidence |
|---|---|---|
| First release | Offline/reconnect state, drafts, responsive task detail, server selection | Real phone background/resume and host outage preserve text without duplicate mutations |
| First release | Windows + Android packages, iOS build/distribution path | Install, launch and reconnect on actual target devices |
| First release | Health/version contract, pairing/transport decision | Unsupported client version and revoked device fail clearly |
| Next | Fleet readiness, drain controls, backups/restore, logs | Dead worker not presented as ready; restore drill succeeds without dispatching duplicates |
| Next | Review inbox, search/filter, task links and DAG view | User can find blocked dependencies and approve work on mobile |
| Next | Artifact receipts and provider registry | One cross-PC Git handoff and one new adapter pass end-to-end tests |
| Optional | Notifications, wake controls, resource-aware scheduling, cost/usage views | Measured delivery/wake behavior and trustworthy underlying telemetry |
| Later | Signed updates, multi-user permissions, audit export | Rollback and access-revocation exercised before wider distribution |

Notifications: foreground in-app alerts first. An SSE connection is not a reliable background mobile notification service. Standard iOS remote notifications use APNs, introducing an external dependency even if the board remains LAN-only. Decide whether that is acceptable; otherwise promise foreground/in-app delivery, not background immediacy. Use minimal notification payloads and fetch details after opening. [Apple APNs registration](https://developer.apple.com/documentation/UserNotifications/registering-your-app-with-apns).

Wake: a sleeping the host cannot execute its own wake endpoint. A supported client native network path or another awake LAN device must send the packet. Test NIC/firmware, power state, wired versus wireless behavior, broadcast reachability and mobile platform permissions. Sending a packet is not success; readiness is success. Do not confuse waking the host with recovering its crashed service.

## 10. Delivery sequence and release gates

1. **Architecture spike:** select shells, remote versus bundled prototype, identity/transport, Apple build/distribution path. Produce one Windows and one mobile connection/offline demo with no native privilege granted to server HTML. Estimate after the spike, not before unknown signing/network issues.
2. **Host contract:** add health/info, task detail, versioned reads/mutations, revisions and idempotency. Keep existing endpoints. Verify reconnect, duplicate request and conflict cases in integration tests.
3. **Shared client:** extract UI; implement drafts and connection state; package desktop/Android; validate iOS on hardware when toolchain available. Maintain browser parity.
4. **Operational release:** supervisor/drain, backup/restore, fleet status, install/update documentation and signed artifacts where applicable. Preserve existing worker protocol or negotiate versions explicitly.
5. **Expansion:** notifications/wake, adapters and artifact handoffs as separate bounded work packages.

Critical test matrix: server absent at app launch; host restart mid-draft; Wi-Fi loss during mutation; client sleeps through updates; expired/revoked credentials; denied LAN permission; different client/server versions; repeated START/END; active remote job during drain; late result after lease expiry; cross-PC dependency without artifacts; incompatible database rollback. Include real devices: desktop emulation cannot prove iOS lifecycle behavior or WoWL.

Release each phase behind an additive path or feature flag; retain browser access and START/END recovery until its replacement is proven. No production deployment, package installation, framework selection or dispatch is authorized merely by approving this document for review.

## 11. Proposed source changes

| Existing area | Planned changes |
|---|---|
| `src/index.ts` | Runtime lifecycle, readiness, signal handling, bounded shutdown |
| `src/server.ts`, `src/mcp.ts` | Versioned API, authorization boundary, identity, compatible legacy adapters |
| `src/events.ts` | Explicit event contract; optional durable replay later |
| `src/store.ts`, `src/types.ts` | Migrations, revisions, operation receipts, device/worker records; future artifacts/providers |
| `src/ui.ts` | Incremental extraction into shared web assets/components and client state |
| `src/dispatcher.ts`, `src/remote.ts` | Drain state, readiness-aware routing, compatibility checks; retain lease invariants |
| `src/worker.ts`, `src/worker-cli.ts` | Registration/readiness, protocol negotiation and recovery reporting |
| `scripts/Stack.ps1` | Bridge to future supervisor without expanding ordinary clients' authority |
| Proposed `apps/desktop`, `apps/mobile`, `packages/client`, `packages/contracts` | Add only after shell spike; directory layout is provisional |
| `tests/`, `docs/` | Contract/lifecycle regression tests, device acceptance evidence and operating instructions |

## 12. Fable workshop handoff

Please review this as a proposal, not a request to implement everything. Read the current source and challenge the assumptions. Give concrete counterexamples, complexity reductions, missing failure cases and a preferred option for each unresolved choice.

Questions to settle:

1. Tauri desktop + Capacitor mobile versus Tauri throughout: which lowers total maintenance for our required native features?
2. Is a temporary remote-view prototype worth shipping, or should bundled UI extraction be the first delivery?
3. What is the smallest useful versioned API and shared client boundary?
4. Which pairing/TLS strategy is least painful across Windows, iOS and Android on this LAN?
5. Scheduled user task versus service: how do we preserve CLI sessions, paths and credentials reliably?
6. What notifications are useful enough to justify APNs/other external delivery infrastructure?
7. What exactly proves a worker ready, a handoff safe and a drain complete?
8. Which improvements should be deleted or deferred to keep v1 small?

Review output format: decision ID; accept/change/reject; rationale; exact affected files/contracts; failure scenario; acceptance test; dependencies. Record unresolved choices in a short decision log. Produce a scoped v1 backlog only after reconciling disagreements.

Suggested Switchboard workshop: create one human-owned master review card, attach this document's path and revision/commit, and keep implementation paused. Codex and Fable can add signed-by-agent comments under that card using existing MCP identities. Use bounded child review cards only if helpful; do not create dependency chains that auto-launch implementations. Label comments as proposal, finding, decision or resolved, with a stable decision ID and document revision. A review response is not deployment approval.

No Switchboard card or agent run was created as part of writing this document. There is no dedicated Switchboard connector exposed in this session; its existing HTTP MCP endpoint is the integration path to verify when beginning the workshop. If Fable runs elsewhere, send the actual document or a Git revision rather than assuming it can read this host's Z: path.
