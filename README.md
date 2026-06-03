# Kiln — Agent Integration Eval Platform

Kiln is a hosted platform that lets API-first companies test whether coding
agents (Claude Code, Codex, Cursor) can successfully integrate their product
using their docs, SDKs, and examples. A DevRel lead submits an eval config
(**task + context + assertions**), Kiln runs a real agent in an isolated
sandbox, grades the output with deterministic tests and an LLM judge, and
produces a **shareable report URL** showing exactly where the agent failed and
what to fix.

> The report URL is the product. The Slack/PR unfurl tells the story before
> anyone clicks.

## Monorepo layout

```
packages/
  web/      — Next.js App Router — submission form + report viewer + OG images
  runner/   — agent orchestration + sandbox execution + context ingestion + BullMQ worker
  grader/   — deterministic assertion runners (shell/http/file) + LLM judge interface
  shared/   — TypeScript types, JSON/Postgres stores, S3 client, sample data
```

This is the MVP wedge: **hosted single-eval with a report link** — no CLI, no
CI, no dashboard. Each module references the design `Decision N` it implements.

### Architecture (Decision 1)

`web` creates evals and run records, then enqueues work. In local development
that job runs in-process; in production mode it can use Redis/BullMQ and the
separate `runner` worker. The runner prepares context, executes a pluggable
agent adapter (Decision 3), collects the event trace, and calls `grade()` from
`grader` (Decision 5). The selected production architecture remains Postgres
for run metadata and S3 for full traces/assets (Decision 7).

```
web ──enqueue──▶ local async job or Redis/BullMQ ──▶ runner.executeRun(config)
                              ├─ ingest context (URL crawl / repo / files)
                              ├─ sandbox (boot → exec → teardown)
                              ├─ Agent.startTask() → AgentEvent[]  (live via SSE, D11)
                              └─ grade(assertions, sandbox) → Verdict[]
                                       │
                              RunResult ──▶ report page (D6/D9) + OG card (D13)
```

## Screens (the visual contract)

The dark, data-dense developer-tool aesthetic (Decision 12) is implemented in
`packages/web/app/globals.css`. Pages:

| Route | Decision | What it shows |
| --- | --- | --- |
| `/` | D14 | Onboarding walkthrough (task → context → tests → report) |
| `/evals/new` | D10, D15, D16 | Guided 4-step eval form with context ingestion + assertion templates |
| `/evals/[id]` | D10, D18 | Shareable eval config + run history + rerun action |
| `/reports/[id]` | D6, D9, D18 | Sticky summary + stats + verdicts + timeline (and platform-error state) |
| `/reports/[id]/diff` | D17 | Side-by-side run comparison with FIXED/REGRESSED tags |
| `/reports/[id]/og` | D13 | Dynamic Open Graph image for Slack/PR unfurls |
| `/api/evals` | D4 | Eval CRUD + job enqueue |
| `/api/evals/[id]` | D4, D18 | Stored eval details + prior runs |
| `/api/evals/[id]/run` | D18 | Re-run an existing eval config |
| `/api/events` | D11 | SSE live execution stream |

## Status — local and production paths

The local hosted-eval flow is wired end to end: submit an eval, create a stored
run, execute the runner, stream live events, grade shell/http/file/LLM
assertions, render the report, render OG output, re-run the eval, and compare
the latest run against the previous one.

The local development path is intentionally dependency-free:

- JSON-backed eval/run store at `.kiln/data.json`.
- URL context ingestion via fetch with bounded same-origin crawling.
- GitHub context ingestion via shallow `git clone` with file and byte caps.
- Local sandbox lifecycle backed by a temporary workspace, real shell exec,
  real file reads, and real HTTP fetch.
- BullMQ enqueue/worker path when Redis env vars are configured, with an
  in-process fallback for local development.
- S3/S3-compatible blob store when `KILN_S3_BUCKET` is configured, with an
  in-memory fallback.

The selected production path is implemented behind environment switches:

- `DATABASE_URL` selects the Postgres metadata store. Run traces are persisted
  through S3 and loaded back into server-rendered reports.
- Redis/BullMQ carries jobs from the web process to the standalone runner.
- `KILN_SANDBOX_MODE=firecracker` selects the Firecracker host-manager client.
  `packages/runner/src/sandbox/host-manager.ts` is the Linux/KVM host service:
  fresh rootfs copy, tap network, Firecracker API boot, SSH guest operations,
  and teardown.
- Claude Code, Codex, and Cursor adapters execute their CLIs inside the selected
  sandbox and normalize JSONL output into report events.
- `ANTHROPIC_API_KEY` plus `KILN_LLM_JUDGE_MODEL` selects the Anthropic
  Messages API judge.

Deployment still requires infrastructure outside this repository: a managed
Postgres instance, Redis, an S3-compatible bucket, Linux KVM hosts with
`/dev/kvm`, a Firecracker kernel, and a rootfs image that starts `sshd` and
contains `curl`, `base64`, and the selected agent CLIs. On AWS, use either a
metal host or a supported nested-virtualization instance family such as
C8i/M8i/R8i with nested virtualization enabled. Provision host-level
forwarding/NAT for tap networks before running public API evals. Slack/PR unfurl
QA and cold-report outreach QA require a deployed public URL.

## Develop

```bash
npm install
npm run dev        # Next.js dev server (packages/web)
npm run build      # build all packages
npm run typecheck  # Next route typegen + strict typecheck across the workspace
npm run lint       # eslint (web)
npm run test       # Vitest unit tests
npm audit --omit=dev --audit-level=moderate
```

## Database

`packages/shared/src/db/schema.ts` exports `SCHEMA_SQL` (users / evals / runs /
verdicts) plus typed row shapes — apply it to a Postgres instance to provision
the store (Decision 7). Set `KILN_DB_AUTO_MIGRATE=1` only when the app should
apply that schema during startup.

## Firecracker host

Build and start the host manager on each Linux/KVM worker host:

```bash
npm run build --workspace=packages/runner
KILN_FIRECRACKER_KERNEL=/opt/kiln/vmlinux \
KILN_FIRECRACKER_ROOTFS=/opt/kiln/agent-rootfs.ext4 \
KILN_FIRECRACKER_SSH_KEY=/opt/kiln/agent-rootfs.key \
npm run start:host-manager --workspace=packages/runner
```

Start the runner service with Redis enabled and point it at that manager:

```bash
RUNNER_ENABLE_QUEUE=1 \
KILN_SANDBOX_MODE=firecracker \
KILN_FIRECRACKER_MANAGER_URL=http://127.0.0.1:8787 \
npm run start:worker --workspace=packages/runner
```

## Runtime configuration

- `KILN_DATA_FILE` overrides the local JSON store path. `DATABASE_URL` selects
  Postgres instead; `KILN_DB_AUTO_MIGRATE=1` applies `SCHEMA_SQL` on startup.
- `NEXT_PUBLIC_APP_URL` controls absolute report/OG URLs.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` enable GitHub OAuth.
  `KILN_REQUIRE_AUTH=1` enforces sign-in outside a production build as well.
- `REDIS_URL`, `KILN_QUEUE_MODE=redis`, and `RUNNER_ENABLE_QUEUE=1` enable the
  Redis/BullMQ web-to-runner path.
- `KILN_S3_BUCKET`, `KILN_S3_REGION`, `KILN_S3_ENDPOINT`,
  `KILN_S3_FORCE_PATH_STYLE`, and `KILN_S3_PREFIX` configure S3-compatible
  trace/blob storage.
- `KILN_SANDBOX_MODE=firecracker`, `KILN_FIRECRACKER_MANAGER_URL`, and
  `KILN_FIRECRACKER_MANAGER_TOKEN` select the microVM host manager.
- `KILN_AGENT_USE_CLI=1` runs the selected guest CLI. Keep
  `KILN_AGENT_FALLBACK=0` for strict production execution; set it to `1` only
  for labelled infrastructure QA without provider credentials.
- `KILN_CLAUDE_COMMAND`, `KILN_CODEX_COMMAND`, and `KILN_CURSOR_COMMAND`
  override guest CLI invocations when a rootfs image needs different flags.
- `ANTHROPIC_API_KEY` and `KILN_LLM_JUDGE_MODEL` enable provider-backed LLM
  judging. Without them, local development uses the labelled heuristic.

See `.env.example` for the complete host-manager configuration.
