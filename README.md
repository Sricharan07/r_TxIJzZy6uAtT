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

**Real and working end-to-end** (verified at runtime):

- Submitting the form → `POST /api/evals` validates the config, runs the
  `executeRun` pipeline, grades it, and **persists** the result; the created
  eval gets its **own** report at `/reports/<runId>` (not a fixed sample).
- The report, diff, and OG card render from the persisted store; re-running an
  eval produces a distinct run and the diff view compares the two (Decision 17).
- GitHub OAuth (Decision 8): `/auth/github` → `/auth/github/callback` performs
  the real token exchange and sets an httpOnly session cookie, with a dev
  fallback so the flow works without credentials configured.
- A real `vitest` suite (`npm test`) covers the grader assertion runners and the
  full `executeRun` integration flow.

**Simulated behind clean interfaces** (require a host fleet / external services
not available in this environment, clearly labelled in code):

- **Firecracker microVMs** — `FirecrackerSandbox` is an in-process simulation of
  the boot/exec/readFile/teardown lifecycle. The simulated Claude Code agent
  writes real files into it, so grading reflects an actual (simulated)
  filesystem rather than canned verdicts.
- **Redis/BullMQ queue** — the runner exposes `executeRun` (run inline by the
  API here); the queue worker is documented and env-guarded.
- **Postgres + S3** — replaced by a `globalThis`-backed in-process store seeded
  with the sample data (same read/write surface as a Postgres impl).
- **Live URL crawling / repo cloning** and the **Anthropic LLM judge** —
  stubbed (`HeuristicJudge`) with the real seam (`LlmJudge`) in place.

Swapping in the real backends does not touch callers.

### Security

`next` is pinned to the latest `14.2.x` patch (`14.2.35`), which clears the
critical advisories. A residual set of DoS-class advisories is only marked fixed
in the Next **16** major; that upgrade (React 19 + App Router API changes) is
deliberately deferred rather than taken blindly. A `postcss` override pins the
patched `8.5.x`.

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
