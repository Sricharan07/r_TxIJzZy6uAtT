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
  web/      — Next.js 14 (App Router) — submission form + report viewer + OG images
  runner/   — agent orchestration + Firecracker sandbox + context ingestion + BullMQ worker
  grader/   — deterministic assertion runners (shell/http/file) + LLM judge
  shared/   — TypeScript types, Postgres schema, S3 client, sample data
```

This is the MVP wedge: **hosted single-eval with a report link** — no CLI, no
CI, no dashboard. Each module references the design `Decision N` it implements.

### Architecture (Decision 1)

`web` enqueues jobs onto a Redis/BullMQ queue; `runner` consumes them, boots a
Firecracker microVM (Decision 2), runs a pluggable agent adapter (Decision 3),
collects the event trace, and calls `grade()` from `grader` (Decision 5). Run
metadata lives in Postgres and full traces in S3 (Decision 7).

```
web ──enqueue──▶ Redis ──▶ runner.executeRun(config)
                              ├─ ingest context (URL crawl / repo / files)
                              ├─ FirecrackerSandbox (boot → exec → teardown)
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
| `/reports/[id]` | D6, D9, D18 | Sticky summary + stats + verdicts + timeline (and platform-error state) |
| `/reports/[id]/diff` | D17 | Side-by-side run comparison with FIXED/REGRESSED tags |
| `/reports/[id]/og` | D13 | Dynamic Open Graph image for Slack/PR unfurls |
| `/api/evals` | D4 | Eval CRUD + job enqueue |
| `/api/events` | D11 | SSE live execution stream |

## Status — what is real vs simulated

The web app, type model, design system, grading dispatch, agent interface, and
the full `executeRun` pipeline are real and compile under strict TypeScript.
Infrastructure that requires a host fleet or external services — **Firecracker
microVMs, live URL crawling / repo cloning, the Anthropic LLM judge call, S3,
and the Redis/BullMQ queue** — is implemented behind clean interfaces with
in-process simulations and is clearly labelled as such in code comments. The
real backends can be swapped in without touching callers. Sample data in
`packages/shared/src/mock.ts` lets every screen render end-to-end.

## Develop

```bash
npm install
npm run dev        # Next.js dev server (packages/web)
npm run build      # build all packages
npm run typecheck  # strict typecheck across the workspace
npm run lint       # eslint (web)
```

## Database

`packages/shared/src/db/schema.ts` exports `SCHEMA_SQL` (users / evals / runs /
verdicts) plus typed row shapes — apply it to a Postgres instance to provision
the store (Decision 7).
