**The sections below are binding.** The approach, spec, and every resolved decision are checkpoints the implementation MUST hit exactly; the preview is the visual contract you MUST reproduce. Do not deviate, re-design, or skip sections. Rejected options are listed as one-liners for context only — they were considered and rejected, do not revive them.

### Approach

_Given conviction-stage demand, a "nothing" status quo, and a hosted-eval wedge — how much should you build before putting it in front of a real DevRel lead?_

**Selected: B. Hosted single-eval report** _(recommended)_

A web app where the DevRel lead configures an eval (API docs, SDK, task description), you run one agent in a sandboxed environment, and they get a shareable report URL showing the full trace, where the agent failed, and what to fix. One agent type, one run at a time, no dashboard or history.

_Other approaches considered:_

- **A. Proof-of-concept script** — _A CLI script that runs one agent against one API task, captures the trace, and writes a local HTML report. You run it manually for a prospect and email them the file. No web app, no hosting, no sandbox infra. Ship in days._
- **C. Hosted eval + multi-agent comparison** — _Everything in B, plus: run the eval across multiple agents (Claude Code, Codex, Cursor), show a side-by-side comparison view, and allow re-running after changes to track whether fixes improved success rates. Basic run history._
- **D. Full CI-integrated platform** — _Complete platform: multi-agent eval, GitHub Action for CI, historical dashboards with trend lines, pre-built task libraries for common API categories (payments, auth, messaging), team accounts, regression alerts._

### Scoping answers

- **1. Demand reality** → **D. Own pain — watched agents fail**
- **2. Who's desperate** → **A. DevRel lead at a mid-size API company**
- **3. Status quo workaround** → **D. Truly nothing**
- **4. Narrowest wedge** → **B. Hosted eval with a report link**

### Decisions

#### Decision 1: System architecture

_How should the system be structured? The core pieces are: a web app (submit eval config, view reports), an execution engine (run agents in sandboxes), and a grading layer (deterministic tests on the output). How tightly coupled should these be?_

**Selected: A. Monorepo, separate services** _(recommended)_

Single repo with three packages: web (Next.js app — submission form + report viewer), runner (agent orchestration + sandbox execution), grader (deterministic test harness). Web enqueues jobs; runner picks them up via a queue (BullMQ/Redis); grader runs inline at end of execution. Deploy web separately from runner.

_Other options considered:_

- **B. Single monolith** — _One Next.js app handles everything: form submission triggers a background job that runs the agent inline (or in a child process), grades it, and writes the report. Simplest to deploy (one process) but agent execution blocks the web serve…_
- **C. CLI core + thin web wrapper** — _Build the eval engine as a standalone CLI tool first (task definition in, report JSON out). The web app is a thin layer that accepts config, shells out to the CLI, and renders the JSON report. Keeps the core portable for future CI integr…_

---

#### Decision 2: Sandbox execution strategy

_Agents need to run in isolation — they'll execute arbitrary code, install packages, make API calls. How should you sandbox them?_

**Selected: C. Firecracker microVMs**

Run Firecracker microVMs on your own infrastructure for maximum isolation and control. Sub-second boot times, strong security boundary. But significant ops burden — you're running a VM fleet.

_Other options considered:_

- **A. Docker containers** — _Spin up a Docker container per eval run with the target SDK pre-installed. Agent runs inside the container with network access (to hit the real API) but filesystem/process isolation. You control the base image, timeout, and resource limi…_
- **B. E2B sandboxes** — _Use E2B's cloud sandboxes — API call spins up an isolated VM in ~300ms. Agent gets a full Linux environment with network access. No Docker management, no infrastructure. Pay per minute of compute. Pre-built templates for common stacks._

---

#### Decision 3: Agent execution model

_How does the system actually "run an agent"? The agent needs to receive a task, interact with the target API/SDK, and produce code that can be tested._

**Selected: C. Pluggable agent interface**

Define an agent interface (start task → stream events → collect artifacts) and implement adapters for Claude Code, Codex CLI, Cursor headless, etc. from day one. Makes multi-agent comparison possible immediately.

_Other options considered:_

- **A. Claude Code via CLI in sandbox** — _Run Claude Code (claude CLI) inside the sandbox with a system prompt describing the integration task. It gets access to the target SDK docs/files, writes code, and can execute it. Capture the full conversation trace + final artifacts. St…_
- **B. Raw API calls with tool use** — _Call the Claude API directly with tool-use enabled (shell, file write, file read). Build a minimal agent loop: prompt → tool call → execute → feed result back. More control over the trace but you're building an agent runtime from scratch._

---

#### Decision 4: Eval task definition format

_How does the DevRel lead describe what they want the agent to do? This is the input format — the "test case" for the eval._

**Selected: B. Web form → stored JSON** _(recommended)_

The web UI walks them through it: paste your task description, upload or link docs/SDK files, define pass criteria (HTTP endpoint returns 200, specific file exists, test command passes). Stored as JSON internally. No YAML authoring required.

_Other options considered:_

- **A. Structured YAML config** — _A YAML file with fields: task (natural language description), setup (files/packages to pre-install), provided_context (docs, SDK files, examples to give the agent), tests (shell commands that must exit 0). Rigid but predictable._
- **C. Natural language only** — _The DevRel lead describes everything in a single text box: "Build a Stripe checkout integration using our Node SDK. It should create a payment intent and handle the webhook." The system infers structure. Magical when it works, unpredicta…_

---

#### Decision 5: Grading strategy

_How do you determine whether the agent succeeded? "Deterministic tests" is the goal — but what form do they take?_

**Selected: B. LLM-as-judge + shell commands**

Shell commands for hard pass/fail checks, plus an LLM judge for softer criteria: "Does the code handle errors gracefully?", "Does it follow the SDK's recommended patterns?" Richer signal but introduces non-determinism.

_Other options considered:_

- **A. Shell-command assertions** — _The eval defines a list of shell commands that must each exit 0 after the agent finishes. Examples: curl localhost:3000/health , node test.js , grep &quot;payment_intent&quot; output.log . Simple, composable, language-agnostic. Each asse…_
- **C. Pytest/Jest test suites** — _The eval includes a full test suite (pytest, jest, etc.) that runs against the agent's output. The DevRel lead writes real tests. Most thorough but highest authoring burden — they need to write tests before they even know what the agent…_

---

#### Decision 6: Report format

_The shareable report URL is the product. What should it show?_

**Selected: A. Timeline + trace + verdicts** _(recommended)_

A single-page report with three sections: (1) Summary card — pass/fail, agent used, duration, task description. (2) Execution timeline — collapsible steps showing each agent action (file created, command run, API called) with timestamps. (3) Test verdicts — each assertion with pass/fail, actual output, and a "what to fix" hint for failures. Shareable via unique URL, no login required.

_Other options considered:_

- **B. Minimal pass/fail card** — _A single card: task name, pass/fail, duration, and a list of which assertions passed/failed. No execution trace, no timeline. Fast to build, but doesn't answer "where did the agent get stuck?"_
- **C. Full conversation transcript** — _Render the complete agent conversation — every prompt, every tool call, every response — as a readable chat log with test results appended. Maximum transparency but overwhelming for non-technical stakeholders._

---

#### Decision 7: Data persistence

_Where do eval configs and reports live? This affects how shareable reports work and whether users can see past runs._

**Selected: A. Postgres + S3** _(recommended)_

Eval configs and run metadata in Postgres. Full traces and report assets in S3. Report pages are server-rendered from the DB. Standard, scalable, supports future features (run history, comparison) without migration.

_Other options considered:_

- **B. SQLite + local filesystem** — _SQLite for metadata, filesystem for traces. Simplest to set up, no external dependencies. But limits deployment options (single server) and makes horizontal scaling painful._
- **C. Supabase (hosted Postgres + storage)** — _Supabase for both database and file storage. Managed Postgres, built-in auth (for later), storage API for traces. Faster than self-hosted Postgres, small vendor dependency._

---

#### Decision 8: Auth and access model for MVP

_For the MVP, who can create evals and who can view reports?_

**Selected: C. GitHub OAuth**

Sign in with GitHub to create evals. Reports are tied to the GitHub user. Natural for the developer audience, but adds OAuth setup and login flow to MVP scope.

_Other options considered:_

- **A. No auth — reports are public by unique URL** — _Anyone with the link can view a report (unguessable UUID in the URL). Eval creation is open or rate-limited by IP. No login, no accounts. Add auth later when teams want private reports._
- **B. Email-based magic links** — _Users enter their email to create an eval. Reports are tied to their email. View access requires the same email (magic link) or a share link. Light auth without passwords._

---

#### Decision 9: Report page layout

_The shareable report URL is the entire product. When a DevRel lead sends this link to their VP or SDK team, what should they see?_

**Selected: A. Stacked sections with sticky summary** _(recommended)_

```html
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 0 auto; background: #09090b; color: #fafafa; padding: 0; border-radius: 12px; overflow: hidden; border: 1px solid #27272a;">
  <!-- Sticky summary bar -->
  <div style="position: sticky; top: 0; background: #18181b; border-bottom: 1px solid #27272a; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; z-index: 10;">
    <div style="display: flex; align-items: center; gap: 12px;">
      <div style="background: #dc2626; color: white; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 6px; letter-spacing: 0.5px;">FAILED</div>
      <span style="font-size: 14px; font-weight: 600;">Acme Payments SDK — Checkout Integration</span>
    </div>
    <div style="font-size: 12px; color: #71717a;">2m 34s · Claude Code · Jun 1, 2026</div>
  </div>
  <!-- Summary card -->
  <div style="padding: 24px; border-bottom: 1px solid #27272a;">
    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 16px;">
      <div style="background: #1c1c1e; border-radius: 8px; padding: 14px;">
        <div style="font-size: 11px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Tests</div>
        <div style="font-size: 22px; font-weight: 700;"><span style="color: #22c55e;">3</span> <span style="color: #52525b;">/</span> <span>5</span></div>
      </div>
      <div style="background: #1c1c1e; border-radius: 8px; padding: 14px;">
        <div style="font-size: 11px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Agent Steps</div>
        <div style="font-size: 22px; font-weight: 700;">17</div>
      </div>
      <div style="background: #1c1c1e; border-radius: 8px; padding: 14px;">
        <div style="font-size: 11px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Duration</div>
        <div style="font-size: 22px; font-weight: 700;">2:34</div>
      </div>
      <div style="background: #1c1c1e; border-radius: 8px; padding: 14px;">
        <div style="font-size: 11px; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Tokens</div>
        <div style="font-size: 22px; font-weight: 700;">48k</div>
      </div>
    </div>
  </div>
  <!-- Test verdicts -->
  <div style="padding: 24px; border-bottom: 1px solid #27272a;">
    <div style="font-size: 13px; font-weight: 600; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px;">Test Verdicts</div>
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; align-items: center; gap: 10px; background: #1c1c1e; padding: 12px 14px; border-radius: 8px;">
        <span style="color: #22c55e; font-size: 16px;">✓</span>
        <span style="font-size: 13px;">SDK installed correctly</span>
      </div>
      <div style="display: flex; align-items: center; gap: 10px; background: #1c1c1e; padding: 12px 14px; border-radius: 8px;">
        <span style="color: #22c55e; font-size: 16px;">✓</span>
        <span style="font-size: 13px;">API client initialized with auth</span>
      </div>
      <div style="display: flex; align-items: center; gap: 10px; background: #1c1c1e; padding: 12px 14px; border-radius: 8px;">
        <span style="color: #22c55e; font-size: 16px;">✓</span>
        <span style="font-size: 13px;">Payment intent created</span>
      </div>
      <div style="display: flex; align-items: center; gap: 10px; background: #2a1215; padding: 12px 14px; border-radius: 8px; border: 1px solid #7f1d1d;">
        <span style="color: #dc2626; font-size: 16px;">✗</span>
        <span style="font-size: 13px; flex: 1;">Webhook handler registered</span>
        <span style="font-size: 11px; color: #71717a; background: #27272a; padding: 2px 8px; border-radius: 4px;">agent got stuck in a loop reading docs</span>
      </div>
      <div style="display: flex; align-items: center; gap: 10px; background: #2a1215; padding: 12px 14px; border-radius: 8px; border: 1px solid #7f1d1d;">
        <span style="color: #dc2626; font-size: 16px;">✗</span>
        <span style="font-size: 13px; flex: 1;">End-to-end checkout flow completes</span>
        <span style="font-size: 11px; color: #71717a; background: #27272a; padding: 2px 8px; border-radius: 4px;">blocked by webhook failure</span>
      </div>
    </div>
  </div>
  <!-- Timeline preview -->
  <div style="padding: 24px;">
    <div style="font-size: 13px; font-weight: 600; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px;">Execution Timeline</div>
    <div style="border-left: 2px solid #27272a; margin-left: 8px; padding-left: 20px; display: flex; flex-direction: column; gap: 14px;">
      <div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 8px; height: 8px; background: #22c55e; border-radius: 50%; margin-left: -25px;"></div>
          <span style="font-size: 12px; color: #71717a;">0:00</span>
          <span style="font-size: 13px; font-weight: 500;">Installed acme-payments-sdk@3.2.1</span>
        </div>
      </div>
      <div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 8px; height: 8px; background: #22c55e; border-radius: 50%; margin-left: -25px;"></div>
          <span style="font-size: 12px; color: #71717a;">0:12</span>
          <span style="font-size: 13px; font-weight: 500;">Created client with API key</span>
        </div>
      </div>
      <div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 8px; height: 8px; background: #22c55e; border-radius: 50%; margin-left: -25px;"></div>
          <span style="font-size: 12px; color: #71717a;">0:38</span>
          <span style="font-size: 13px; font-weight: 500;">Called createPaymentIntent — 200 OK</span>
        </div>
      </div>
      <div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 10px; height: 10px; background: #dc2626; border-radius: 50%; margin-left: -26px; border: 2px solid #7f1d1d;"></div>
          <span style="font-size: 12px; color: #71717a;">0:52</span>
          <span style="font-size: 13px; font-weight: 500; color: #fca5a5;">Read webhook docs 4 times — looped without progress</span>
        </div>
        <div style="margin-left: 32px; margin-top: 6px; background: #1c1c1e; border-radius: 6px; padding: 10px 12px; font-size: 12px; color: #a1a1aa; border-left: 3px solid #dc2626;">
          <strong style="color: #fca5a5;">Why it failed:</strong> The webhook setup docs reference <code style="background: #27272a; padding: 1px 5px; border-radius: 3px;">registerEndpoint()</code> but the SDK exports <code style="background: #27272a; padding: 1px 5px; border-radius: 3px;">webhooks.listen()</code>. The agent couldn't reconcile the mismatch.
        </div>
      </div>
      <div style="font-size: 12px; color: #52525b; padding: 4px 0;">⋯ 13 more steps</div>
    </div>
  </div>
</div>
```

Sticky pass/fail banner stays visible while scrolling. Stats grid gives the executive summary. Test verdicts show what passed and what failed with inline failure hints. Timeline below shows every agent step with failure annotations expanded. The VP gets the headline; the SDK engineer gets the trace.

_Other options considered:_

- **B. Two-column: verdicts left, trace right** — _Verdicts and trace side by side — click a failed verdict to jump to that point in the trace. More information-dense but harder to scan on mobile. Better for SDK engineers doing deep debugging, worse for VP-level sharing._

---

#### Decision 10: Eval submission experience

_How should the DevRel lead configure and launch an eval? This is the first thing they interact with._

**Selected: A. Guided multi-step form** _(recommended)_

```html
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; background: #09090b; color: #fafafa; padding: 32px; border-radius: 12px; border: 1px solid #27272a;">
  <!-- Progress steps -->
  <div style="display: flex; align-items: center; gap: 0; margin-bottom: 32px;">
    <div style="display: flex; align-items: center; gap: 6px;">
      <div style="width: 28px; height: 28px; background: #2563eb; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600;">1</div>
      <span style="font-size: 12px; font-weight: 500; color: #2563eb;">Task</span>
    </div>
    <div style="flex: 1; height: 1px; background: #27272a; margin: 0 12px;"></div>
    <div style="display: flex; align-items: center; gap: 6px;">
      <div style="width: 28px; height: 28px; background: #27272a; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #71717a;">2</div>
      <span style="font-size: 12px; color: #71717a;">Context</span>
    </div>
    <div style="flex: 1; height: 1px; background: #27272a; margin: 0 12px;"></div>
    <div style="display: flex; align-items: center; gap: 6px;">
      <div style="width: 28px; height: 28px; background: #27272a; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #71717a;">3</div>
      <span style="font-size: 12px; color: #71717a;">Tests</span>
    </div>
    <div style="flex: 1; height: 1px; background: #27272a; margin: 0 12px;"></div>
    <div style="display: flex; align-items: center; gap: 6px;">
      <div style="width: 28px; height: 28px; background: #27272a; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #71717a;">4</div>
      <span style="font-size: 12px; color: #71717a;">Run</span>
    </div>
  </div>
  <!-- Step 1: Task -->
  <div>
    <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 8px;">What should the agent build?</label>
    <textarea style="width: 100%; box-sizing: border-box; background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 12px; color: #fafafa; font-size: 13px; min-height: 80px; resize: vertical; font-family: inherit;" placeholder="e.g. Build a checkout flow using our Payments SDK. Create a payment intent for $20, confirm it, and handle the webhook for payment_succeeded.">Build a checkout flow using the Acme Payments SDK. Create a payment intent for $20, confirm it with a test card, and set up a webhook handler for payment_succeeded.</textarea>
    <p style="font-size: 11px; color: #52525b; margin-top: 6px;">Describe a realistic integration task that a developer would accomplish with your API.</p>
  </div>
  <div style="margin-top: 24px;">
    <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 8px;">Language / runtime</label>
    <div style="display: flex; gap: 8px;">
      <div style="background: #2563eb22; border: 1px solid #2563eb; border-radius: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer;">Node.js</div>
      <div style="background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 8px 16px; font-size: 13px; color: #71717a; cursor: pointer;">Python</div>
      <div style="background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 8px 16px; font-size: 13px; color: #71717a; cursor: pointer;">Go</div>
      <div style="background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 8px 16px; font-size: 13px; color: #71717a; cursor: pointer;">Other</div>
    </div>
  </div>
  <div style="display: flex; justify-content: flex-end; margin-top: 32px;">
    <div style="background: #2563eb; color: white; padding: 10px 24px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer;">Next: Add Context →</div>
  </div>
</div>
```

Four steps: (1) Describe the task + pick language, (2) Upload docs/SDK files or paste URLs, (3) Define pass/fail assertions, (4) Review and run. Each step is simple. Guides them through the mental model of "task + context + tests = eval."

_Other options considered:_

- **B. Single-page form with sections** — _Everything on one page — faster for repeat users who know the model. But the DevRel lead seeing this for the first time has to understand task + context + assertions all at once. Higher cognitive load on first use._

---

#### Decision 11: Running state experience

_Evals take 1-5 minutes. What does the user see while waiting? This is a high-anxiety moment — they just submitted and don't know if it's working._

**Selected: A. Live streaming timeline** _(recommended)_

```html
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; background: #09090b; color: #fafafa; padding: 32px; border-radius: 12px; border: 1px solid #27272a;">
  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px;">
    <div style="display: flex; align-items: center; gap: 10px;">
      <div style="width: 10px; height: 10px; background: #eab308; border-radius: 50%; animation: pulse 1.5s infinite;"></div>
      <span style="font-size: 14px; font-weight: 600;">Running — Acme Payments Checkout</span>
    </div>
    <span style="font-size: 13px; color: #71717a; font-variant-numeric: tabular-nums;">1:42 elapsed</span>
  </div>
  <!-- Live steps -->
  <div style="border-left: 2px solid #27272a; margin-left: 8px; padding-left: 20px; display: flex; flex-direction: column; gap: 12px;">
    <div style="display: flex; align-items: center; gap: 8px;">
      <div style="width: 8px; height: 8px; background: #22c55e; border-radius: 50%; margin-left: -25px;"></div>
      <span style="font-size: 12px; color: #52525b;">0:00</span>
      <span style="font-size: 13px; color: #a1a1aa;">Sandbox provisioned</span>
    </div>
    <div style="display: flex; align-items: center; gap: 8px;">
      <div style="width: 8px; height: 8px; background: #22c55e; border-radius: 50%; margin-left: -25px;"></div>
      <span style="font-size: 12px; color: #52525b;">0:03</span>
      <span style="font-size: 13px; color: #a1a1aa;">Agent started — reading task</span>
    </div>
    <div style="display: flex; align-items: center; gap: 8px;">
      <div style="width: 8px; height: 8px; background: #22c55e; border-radius: 50%; margin-left: -25px;"></div>
      <span style="font-size: 12px; color: #52525b;">0:08</span>
      <span style="font-size: 13px; color: #a1a1aa;">npm install acme-payments-sdk</span>
    </div>
    <div style="display: flex; align-items: center; gap: 8px;">
      <div style="width: 8px; height: 8px; background: #22c55e; border-radius: 50%; margin-left: -25px;"></div>
      <span style="font-size: 12px; color: #52525b;">0:24</span>
      <span style="font-size: 13px; color: #a1a1aa;">Created AcmeClient, reading docs</span>
    </div>
    <div style="display: flex; align-items: center; gap: 8px;">
      <div style="width: 8px; height: 8px; background: #22c55e; border-radius: 50%; margin-left: -25px;"></div>
      <span style="font-size: 12px; color: #52525b;">1:12</span>
      <span style="font-size: 13px; color: #a1a1aa;">createPaymentIntent() → 200 OK</span>
    </div>
    <div style="display: flex; align-items: center; gap: 8px;">
      <div style="width: 10px; height: 10px; background: #eab308; border-radius: 50%; margin-left: -26px; border: 2px solid #854d0e;"></div>
      <span style="font-size: 12px; color: #52525b;">1:38</span>
      <span style="font-size: 13px; color: #fafafa; font-weight: 500;">Reading webhook documentation…</span>
    </div>
  </div>
  <div style="margin-top: 20px; padding: 12px 16px; background: #18181b; border-radius: 8px; display: flex; align-items: center; gap: 8px;">
    <div style="width: 6px; height: 6px; background: #eab308; border-radius: 50;"></div>
    <span style="font-size: 12px; color: #71717a;">Agent is actively working — this page updates live</span>
  </div>
</div>
```

Steps appear in real-time as the agent works. The user watches the agent install packages, read docs, call APIs. Builds confidence that something is happening and gives early signal on whether it's going well. Transitions seamlessly into the final report when done.

_Other options considered:_

- **B. Progress bar with status text** — _Simpler to build — a progress bar with a single status line. Less information but less engineering effort. Doesn't give the "watching the agent work" experience. The user doesn't know what's happening under the hood until it's done._

---

#### Decision 12: Visual identity and tone

_This product targets technical DevRel leads at API companies. What visual tone should it strike?_

**Selected: A. Dark, data-dense, developer-tool aesthetic** _(recommended)_

Dark backgrounds (#09090b), monospace accents for code/commands, high-contrast status colors (green/red), minimal chrome. Think Linear, Vercel dashboard, or Datadog. Signals "this is a serious engineering tool" — which matches the buyer (DevRel lead reporting to VP Eng).

_Other options considered:_

- **B. Light, clean, documentation-style** — _White backgrounds, generous whitespace, soft blues and grays, rounded cards. Think Stripe docs, Notion, or ReadMe. Approachable and familiar but risks looking like "just another docs tool" rather than a monitoring/testing product._
- **C. Terminal-native, hacker aesthetic** — _Green-on-black, monospace everything, ASCII-art elements, minimal UI controls. Think GitHub's terminal theme or Warp. Maximum developer credibility but alienates the VP audience who receives the shared report link._

---

#### Decision 13: Report sharing OG preview

_When the DevRel lead pastes the report URL into Slack or a PR, what should the Open Graph preview card show?_

**Selected: A. Status + score + task name** _(recommended)_

```html
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; background: #18181b; border-radius: 10px; overflow: hidden; border: 1px solid #27272a;">
  <div style="padding: 20px 24px;">
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
      <span style="font-size: 11px; color: #71717a;">kiln.dev</span>
    </div>
    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
      <div style="background: #dc2626; color: white; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 4px;">FAILED</div>
      <span style="font-size: 15px; font-weight: 600; color: #fafafa;">Acme Payments — Checkout Integration</span>
    </div>
    <div style="font-size: 13px; color: #a1a1aa;">3/5 tests passed · Claude Code · 2m 34s</div>
    <div style="font-size: 12px; color: #71717a; margin-top: 6px;">Agent got stuck on webhook setup — docs reference registerEndpoint() but SDK exports webhooks.listen()</div>
  </div>
  <div style="background: #09090b; padding: 12px 24px; border-top: 1px solid #27272a; display: flex; gap: 16px;">
    <div style="display: flex; align-items: center; gap: 4px;"><span style="color: #22c55e; font-size: 14px;">✓</span><span style="font-size: 12px; color: #71717a;">3 passed</span></div>
    <div style="display: flex; align-items: center; gap: 4px;"><span style="color: #dc2626; font-size: 14px;">✗</span><span style="font-size: 12px; color: #71717a;">2 failed</span></div>
  </div>
</div>
```

The Slack unfurl tells the story without clicking: what failed, why, and how bad. The DevRel lead drops this in #sdk-team and the conversation starts immediately. This IS the product's virality mechanism — the preview must be information-rich enough to be useful on its own.

_Other options considered:_

- **B. Minimal brand card** — _Clean and simple but reveals nothing — the recipient has to click to learn anything. Misses the opportunity to start the conversation in Slack before anyone clicks._

---

#### Decision 14: Time-to-first-report

_A DevRel lead signs in with GitHub and lands on the dashboard. How fast can they see their first eval report? What's the golden path from "just signed up" to "I'm looking at a report showing where Claude failed on my API"?_

**Selected: C. Under 15 minutes — onboarding walkthrough first**

A guided onboarding tour explains concepts (what's an eval, what's a task, what are assertions) before they create anything. Thorough but patronizing for the DevRel audience — they understand testing concepts, they just need to see it working on their API.

_Other options considered:_

- **A. Under 5 minutes — prefilled example eval** — _After GitHub OAuth, they land on a page with a pre-configured example eval (a simple API integration task against a mock API). One click to run it. They see the live timeline, then the report — in under 2 minutes. Below that: "Now try it…_
- **B. Under 10 minutes — straight to the form** — _After OAuth, they land directly on the guided multi-step form (Step 1: describe your task). No example eval. They configure their own eval from scratch, run it, and get a report. Faster to build, but the user invests 5+ minutes of config…_

---

#### Decision 15: Context file ingestion

_In Step 2 of the eval form, the DevRel lead provides "context" — the docs, SDK, examples the agent should use. How should this work? This is the highest-friction step: they have to teach the system about their API._

**Selected: A. URL crawler + file upload + paste** _(recommended)_

Three input modes: (1) Paste a docs URL and we crawl it (with depth control — "just this page" vs "this page + linked pages"), (2) Upload files directly (SDK source, example code, README), (3) Paste text/code inline. All three contribute to the context bundle. Preview shows what the agent will see, with token count estimate.

_Other options considered:_

- **B. GitHub repo link** — _Paste a GitHub repo URL and we clone the relevant directories. Good for SDK repos. Add a file picker to select which directories/files to include. Doesn't work for docs hosted on custom sites or for content that isn't in a repo._
- **C. Upload only** — _Drag-and-drop files only. Simple and predictable. But forces the DevRel lead to manually download their own docs into files before uploading — unnecessary friction when the content is already on the web._

---

#### Decision 16: Assertion authoring UX

_In Step 3, the DevRel lead defines pass/fail tests. Most DevRel leads aren't writing bash one-liners daily. How should assertion authoring work?_

**Selected: A. Template picker + custom shell** _(recommended)_

```html
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; background: #09090b; color: #fafafa; padding: 24px; border-radius: 12px; border: 1px solid #27272a;">
  <div style="font-size: 13px; font-weight: 600; margin-bottom: 14px;">Pass/fail assertions</div>
  <!-- Existing assertions -->
  <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">
    <div style="background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 12px; background: #1e3a5f; color: #93c5fd; padding: 2px 8px; border-radius: 4px;">HTTP</span>
        <span style="font-size: 13px;">Server responds at localhost:3000/health</span>
      </div>
      <span style="color: #52525b; cursor: pointer; font-size: 16px;">×</span>
    </div>
    <div style="background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 12px; background: #1a2e1a; color: #86efac; padding: 2px 8px; border-radius: 4px;">FILE</span>
        <span style="font-size: 13px;">File exists: src/checkout.ts</span>
      </div>
      <span style="color: #52525b; cursor: pointer; font-size: 16px;">×</span>
    </div>
    <div style="background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 12px; background: #2a2017; color: #fbbf24; padding: 2px 8px; border-radius: 4px;">SHELL</span>
        <code style="font-size: 12px; color: #a1a1aa; font-family: monospace;">node test.js</code>
      </div>
      <span style="color: #52525b; cursor: pointer; font-size: 16px;">×</span>
    </div>
  </div>
  <!-- Add new -->
  <div style="font-size: 12px; color: #71717a; margin-bottom: 10px;">Add assertion</div>
  <div style="display: flex; gap: 8px; flex-wrap: wrap;">
    <div style="background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 8px 14px; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 6px;">
      <span style="color: #93c5fd;">+</span> HTTP endpoint returns 200
    </div>
    <div style="background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 8px 14px; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 6px;">
      <span style="color: #86efac;">+</span> File exists
    </div>
    <div style="background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 8px 14px; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 6px;">
      <span style="color: #86efac;">+</span> File contains string
    </div>
    <div style="background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 8px 14px; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 6px;">
      <span style="color: #fbbf24;">+</span> Shell command exits 0
    </div>
    <div style="background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 8px 14px; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 6px;">
      <span style="color: #c4b5fd;">+</span> LLM judge
    </div>
  </div>
</div>
```

Pre-built templates for common assertion types (HTTP check, file exists, file contains, shell command, LLM judge). Each template opens a small form with the right fields. Power users can always drop to a raw shell command. The template buttons lower the barrier — no bash knowledge needed for the basics.

_Other options considered:_

- **B. Natural language → auto-generated assertions** — _User describes success in plain English, an LLM generates shell assertions from the description. User can edit, remove, or add more. Lowest authoring friction but generated assertions may miss edge cases or be overly simplistic. Requires…_

---

#### Decision 17: Re-run and iteration flow

_The DevRel lead sees the report, finds that their webhook docs are confusing the agent. They fix the docs. Now what? How do they re-run the same eval to see if the fix worked?_

**Selected: B. Side-by-side diff of two runs**

Re-run produces a new report AND a comparison view: test verdicts side by side, showing which tests flipped from fail to pass (or vice versa). More valuable but significantly more engineering effort — you need to align two different execution traces and diff the verdicts.

_Other options considered:_

- **A. "Re-run" button on the report page** — _A prominent "Re-run this eval" button on every report. Clicking it opens the eval config pre-filled with the same settings, but lets them update the context (re-crawl the docs URL, swap a file). Run it again, get a new report. The old re…_
- **C. Auto-rerun via webhook/CI trigger** — _Set up a webhook that triggers a re-run when docs deploy. The report page shows "last run: 2h ago, next run: on deploy." Fully automated iteration loop — but requires webhook infrastructure and the DevRel lead to configure a deploy hook.…_

---

#### Decision 18: Error and failure communication

_Evals can fail for reasons unrelated to the API — the sandbox times out, the agent hits a rate limit, the LLM judge errors. How do you distinguish "your API has a problem" from "our platform had a problem"?_

**Selected: A. Clear platform-error vs API-error states** _(recommended)_

Two distinct report states: (1) "Eval completed — N/M tests passed" (the eval ran, some tests failed, this is your API's signal) and (2) "Eval errored — platform issue" (sandbox crashed, agent timed out, internal error — not your fault, re-run for free). Platform errors show a different UI treatment (gray/yellow, not red) with a "Retry" button and no test verdicts. Never blame the user's API for our infrastructure failures.

_Other options considered:_

- **B. Single error state with root-cause tag** — _All failures show the same report layout, but each has a root-cause tag: "API issue," "docs issue," "platform issue," "timeout." Simpler to implement but conflates signal with noise — the DevRel lead has to mentally filter which failures…_

---

#### Decision 19: Eval config sharing and teams

_A DevRel lead creates a great eval config. Their SDK engineer wants to run the same eval after fixing the docs. How do eval configs get shared in the MVP?_

**Selected: A. Shareable eval config URL** _(recommended)_

Every eval config gets its own URL (like the report). Anyone with the link can view the config and click "Run this eval" to execute it with their own GitHub identity. The DevRel lead creates the eval, sends the config link to the SDK engineer, they run it after the fix. No team management, no permissions — just URLs.

_Other options considered:_

- **B. Export/import JSON** — _An "Export config" button downloads the eval definition as JSON. The SDK engineer imports it to create a new eval. Works offline, version-controllable, but clunky — copy a file instead of sharing a link._
- **C. GitHub org-based teams** — _Eval configs belong to a GitHub org. Anyone in the org can see and run all evals. Requires building org management, membership sync, and permissions. Meaningful for enterprise but overkill for MVP._

---

#### Decision 20: Pricing model for MVP

_You need to charge eventually, but the wrong pricing model at this stage can kill adoption before you learn anything. How do you monetize (or not) the MVP?_

**Selected: A. Free with generous limits, usage gate later** _(recommended)_

Completely free for the first N evals (e.g. 10/month per account). No credit card required. You want the DevRel lead to run their first eval in under 15 minutes — a paywall kills that. Once they're running evals regularly (signal: re-runs after doc changes), introduce paid tiers. You learn usage patterns before pricing.

_Other options considered:_

- **B. Pay-per-eval from day one** — _Charge per eval run ($5-15/run). Credit card at signup. Validates willingness-to-pay immediately — every run is a revenue signal. But creates friction at the exact moment you need adoption. A DevRel lead exploring the tool won't expense…_
- **C. Free for individuals, paid for teams/orgs** — _Single users run unlimited evals free. Charge when they want team features (shared configs, org-level dashboards, SSO). Aligns payment with the expansion moment — but that moment may be months away, and you need signal now on whether the…_

---

#### Decision 21: Go-to-market motion

_You have a product that generates a shareable report URL. How do you get the first 10 DevRel leads to try it?_

**Selected: A. Run evals yourself, send cold reports** _(recommended)_

Pick 10 mid-size API companies (Twilio, Plaid, Resend, Clerk, etc.). Run their public APIs/SDKs through your eval using their own docs. Send the DevRel lead an unsolicited report: "Here's where Claude fails on your Payments API — 3/5 tests passed. The webhook docs are the bottleneck." The report IS the pitch. No deck, no demo request — a live artifact showing their problem.

_Other options considered:_

- **B. Content marketing + waitlist** — _Publish blog posts and tweets showing agent failure patterns on popular APIs ("We tested 20 payment APIs with Claude Code — here's what broke"). Build a waitlist. Let inbound interest drive early access. Slower but builds an audience and…_
- **C. Launch on Product Hunt / Hacker News** — _Ship the MVP and do a public launch. DevRel people are on HN and PH. Get 500 signups on day one, learn from usage. High variance — could be a signal flood or a ghost town depending on timing and positioning._
- **D. Partner with agent companies** — _Pitch Anthropic, OpenAI, Anysphere (Cursor) on co-marketing: "We help your users' APIs work better with your agent." They have DevRel networks and want to show their agents succeed. Long sales cycle but high-credibility distribution chan…_

---

#### Decision 22: Defensibility and moat

_If this works, what stops Datadog, Postman, or the agent companies themselves from building it? What's your structural advantage?_

**Selected: A. Benchmark data network effect** _(recommended)_

Every eval run generates data: which APIs agents succeed/fail on, which doc patterns cause confusion, which SDK designs work. Over time, you build a cross-company benchmark dataset that no single API company can replicate. Publish anonymized leaderboards ("Top 10 most agent-friendly payment APIs"). The data moat compounds — each new customer makes the benchmark more valuable for everyone.

_Other options considered:_

- **B. Pre-built eval templates per API category** — _Build curated eval suites for popular categories: payments, auth, messaging, email, databases. New customers get value in minutes, not hours. Templates encode domain expertise that's expensive to replicate — but templates are copyable on…_
- **C. Speed of iteration and agent expertise** — _You're closer to the problem than any incumbent. You'll ship eval improvements weekly while Datadog adds it as a checkbox feature in 18 months. Execution speed is the moat — but it's temporary by definition._
- **D. Integration with CI/CD and developer workflow** — _Once embedded in a team's CI pipeline ("every docs PR triggers an agent eval"), switching costs are high. The eval config, historical baselines, and team workflows lock them in. But CI integration is v2+ — you need to earn the right to b…_

---

#### Decision 23: Success metric for the MVP

_You're shipping a hosted eval with a report link. What's the one metric that tells you whether this is working — not vanity (signups, page views) but the thing that proves the product has value?_

**Selected: A. Re-run rate — % of users who run a second eval** _(recommended)_

A user who runs one eval is curious. A user who runs a second eval — especially after changing their docs/SDK — found the first report actionable enough to come back. This is the "aha → habit" signal. Target: 30%+ of first-time users run a second eval within 7 days.

_Other options considered:_

- **B. Report shares — % of reports shared externally** — _If the DevRel lead shares the report URL (Slack, email, PR), they found it valuable enough to show someone else. This is both a retention signal and a growth signal. Harder to measure (you see the link click from a new IP, not the share…_
- **C. Time-to-fix — how fast they change docs/SDK after seeing the report** — _If the report causes a docs commit or SDK change within 48 hours, the product drove real action. The strongest possible signal — but nearly impossible to measure without integrating with their repo._
- **D. NPS or qualitative feedback** — _Ask users after their first report: "How likely are you to recommend this?" or "What did you learn?" Direct signal on perceived value. But NPS is noisy at small N and qualitative feedback doesn't scale._

---

#### Decision 24: What to build second

_Assuming the MVP validates (DevRel leads re-run evals after fixing docs), what's the next thing you build? This shapes what to optimize for in the MVP architecture._

**Selected: B. CI integration (GitHub Action)** _(recommended)_

A GitHub Action that runs the eval on every docs/SDK PR. "Your PR broke agent integration — webhook test went from pass to fail." This is the "Sentry" upgrade: from one-off diagnostic tool to continuous monitoring. It's also the pricing moment — CI integration is a team feature worth paying for.

_Other options considered:_

- **A. Multi-agent comparison** — _Run the same eval across Claude Code, Codex, and Cursor. Show which agents succeed and fail on the same API. This is the "leaderboard" play — DevRel leads share it because it's interesting data, not just a bug report. Drives virality and…_
- **C. Pre-built eval templates** — _Curated eval suites for common API categories (payments, auth, messaging). New users see results instantly without authoring tasks or assertions. Reduces time-to-value from 15 minutes to 2 minutes. But you need to know which categories m…_
- **D. Dashboard with historical trends** — _A dashboard showing eval results over time: "Your agent integration score improved from 60% to 80% after the docs rewrite." Turns point-in-time reports into a trendline. Compelling for VP-level reporting but only meaningful after a user…_

### Spec

### Kiln — Agent Integration Eval Platform Spec

### Overview

Kiln is a hosted platform that lets API-first companies test whether coding agents (Claude Code, Codex, Cursor, etc.) can successfully integrate their product using their docs, SDKs, and examples. A DevRel lead submits an eval config (task + context + assertions), Kiln runs real agents in isolated sandboxes, grades the output with deterministic tests and LLM judges, and produces a shareable report URL showing exactly where the agent failed and what to fix.

**Target user:** DevRel lead at a mid-size API company (Twilio, Plaid, Resend-tier) who owns developer adoption metrics and has zero instrumentation for agent integration success today.

**Wedge:** Hosted single-eval with a shareable report link. No CLI, no CI, no dashboard — just "configure → run → share the report URL."

**GTM:** Run evals against 10 public APIs ourselves and cold-send the reports to DevRel leads. The report IS the pitch.

**North star metric:** Re-run rate (% of users who run a second eval within 7 days) + report share rate (% of reports viewed by someone other than the creator). Target: 30%+ re-run within 7 days.

---

### Decision 1: System architecture
**Chosen:** Monorepo, separate services
**Rationale:** Three packages in one repo — `web` (Next.js app for submission form + report viewer), `runner` (agent orchestration + sandbox execution), `grader` (deterministic test harness + LLM judge). Web enqueues jobs via BullMQ/Redis; runner picks them up asynchronously. Clean separation without premature microservices. Deploy web and runner independently so long-running agent executions don't block the web server.

### Decision 2: Sandbox execution strategy
**Chosen:** Firecracker microVMs
**Rationale:** Maximum isolation and control for running untrusted agent-generated code. Sub-second boot times with strong security boundaries. Requires running a VM fleet (significant ops burden), but gives full control over networking, resource limits, and base images. Each eval run gets a fresh microVM with the target SDK pre-installed and network access to hit the real API.

### Decision 3: Agent execution model
**Chosen:** Pluggable agent interface
**Rationale:** Define an agent interface (`startTask → streamEvents → collectArtifacts`) and implement adapters for Claude Code, Codex CLI, and future agents from day one. This enables the multi-agent comparison feature (Decision 24's successor) without a rewrite. Each adapter translates the agent's native output into a common event stream that the runner captures for the trace/timeline.

### Decision 4: Eval task definition format
**Chosen:** Web form → stored JSON
**Rationale:** The web UI walks the DevRel lead through configuration via a guided multi-step form (Decision 10). Internally stored as JSON — the user never writes YAML or config files. The JSON schema includes: `task` (natural language description), `language` (runtime), `context` (array of source references), `assertions` (array of test definitions), and `metadata` (agent type, timeout).

### Decision 5: Grading strategy
**Chosen:** LLM-as-judge + shell commands
**Rationale:** Shell commands (`curl`, `grep`, `node test.js`) provide deterministic pass/fail for hard criteria. LLM judge adds softer evaluation: "Does the code follow SDK patterns?", "Is error handling idiomatic?" Each assertion is typed (`shell` or `llm`) and gets an independent pass/fail in the report. LLM judge verdicts are visually tagged in the UI so users know which results are deterministic vs. AI-evaluated.

### Decision 6: Report format
**Chosen:** Timeline + trace + verdicts
**Rationale:** Single-page report with three sections: (1) summary card (pass/fail, agent, duration, task), (2) execution timeline (collapsible agent steps with timestamps), (3) test verdicts (each assertion with pass/fail, output, and failure hints). The report URL is the entire product — it must serve both the VP who needs the headline and the SDK engineer who needs the trace.

### Decision 7: Data persistence
**Chosen:** Postgres + S3
**Rationale:** Eval configs and run metadata in Postgres. Full execution traces and report assets (OG images, etc.) in S3. Report pages are server-rendered from the DB. Standard stack that supports future features (run history, comparison, dashboards) without migration.

### Decision 8: Auth and access model
**Chosen:** GitHub OAuth
**Rationale:** Sign in with GitHub to create evals. Reports are tied to the GitHub user. Natural for the developer audience. Reports are viewable by anyone with the link (no auth required to view), but eval creation requires GitHub sign-in to prevent abuse and enable usage tracking.

### Decision 9: Report page layout
**Chosen:** Stacked sections with sticky summary
**Rationale:** Sticky pass/fail banner stays visible while scrolling. Stats grid (tests, steps, duration, tokens) gives the executive summary at a glance. Test verdicts section with inline failure hints. Execution timeline below with failure annotations expanded by default. Mobile-friendly single-column layout.

### Decision 10: Eval submission experience
**Chosen:** Guided multi-step form
**Rationale:** Four steps: (1) Task — describe what the agent should build + pick language, (2) Context — add docs/SDK/examples via URL, GitHub repo, file upload, or paste, (3) Tests — define pass/fail assertions with template picker, (4) Review & Run. Each step is focused and simple. Teaches the mental model: task + context + tests = eval.

### Decision 11: Running state experience
**Chosen:** Live streaming timeline
**Rationale:** Steps appear in real-time via SSE/WebSocket as the agent works. The user watches the agent install packages, read docs, call APIs. Builds confidence during the 1-5 minute wait. The running timeline transitions seamlessly into the final report when execution completes — same UI, just finalized.

### Decision 12: Visual identity and tone
**Chosen:** Dark, data-dense, developer-tool aesthetic
**Rationale:** Dark backgrounds (#09090b), monospace accents for code/commands, high-contrast green/red status colors, minimal chrome. Signals "serious engineering tool" — matches the buyer (DevRel lead reporting to VP Eng) and the category (monitoring/testing, not docs).

### Decision 13: Report sharing OG preview
**Chosen:** Status + score + task name
**Rationale:** When the report URL is pasted into Slack or a PR, the Open Graph card shows: pass/fail badge, test score (3/5), task name, and a one-line failure summary. Information-rich enough to start a conversation before anyone clicks. This IS the virality mechanism. Requires a dynamic OG image generation endpoint (e.g., `@vercel/og` or Satori).

### Decision 14: Time-to-first-report
**Chosen:** Under 15 minutes — onboarding walkthrough first
**Rationale:** After GitHub OAuth, new users see a guided onboarding page explaining the four-step eval model (task, context, tests, report) before creating anything. Then they proceed to the guided form. Ensures users understand the concepts before investing configuration effort.

### Decision 15: Context file ingestion
**Chosen:** URL crawler + GitHub repo + file upload + paste
**Rationale:** Four input modes: (1) Paste a docs URL with depth control (single page vs. linked pages), (2) GitHub repo URL with file/directory picker, (3) Direct file upload, (4) Inline text/code paste. All contribute to a unified context bundle. Preview shows what the agent will see with token count estimate. URLs and repos are re-fetchable on re-runs so context stays fresh.

### Decision 16: Assertion authoring UX
**Chosen:** Template picker + custom shell
**Rationale:** Pre-built templates for common assertion types: HTTP endpoint check, file exists, file contains string, shell command (exit 0), and LLM judge. Each template opens a focused form with the right fields. Power users can always drop to raw shell commands. Template buttons lower the barrier for DevRel leads who aren't writing bash daily.

### Decision 17: Re-run and iteration flow
**Chosen:** Side-by-side diff of two runs
**Rationale:** "Re-run" button on every report opens the eval config pre-filled. After the new run completes, a comparison view shows test verdicts side by side with "FIXED" / "REGRESSED" tags on tests that flipped. The DevRel lead sees immediately whether their docs fix improved agent success. Both individual reports remain accessible via their own URLs.

### Decision 18: Error and failure communication
**Chosen:** Clear platform-error vs API-error states
**Rationale:** Two distinct report states: (1) "Eval completed — N/M tests passed" (the API's signal, shown in red/green), and (2) "Eval errored — platform issue" (sandbox crash, timeout, internal error — shown in yellow/gray). Platform errors get a free "Retry" button and no test verdicts. Never blame the user's API for infrastructure failures.

### Decision 19: Eval config sharing and teams
**Chosen:** Shareable eval config URL
**Rationale:** Every eval config gets a unique URL. Anyone with the link can view the config and click "Run this eval" with their own GitHub identity. The DevRel lead creates the eval, shares the config URL with their SDK engineer, they re-run after fixes. No team management, no permissions — just URLs. Matches the report sharing model.

### Decision 20: Pricing model
**Chosen:** Free with generous limits, usage gate later
**Rationale:** Free for the first 10 evals/month per account. No credit card required. Maximize adoption and learning velocity. Introduce paid tiers once users are running evals regularly (signal: re-runs after doc changes). Price based on observed usage patterns, not assumptions.

### Decision 21: Go-to-market motion
**Chosen:** Run evals yourself, send cold reports
**Rationale:** Pick 10 mid-size API companies. Run their public APIs/SDKs through Kiln. Send the DevRel lead an unsolicited report: "Here's where Claude fails on your Payments API — 3/5 tests passed. The webhook docs are the bottleneck." The report IS the pitch — proof, not promises.

### Decision 22: Defensibility and moat
**Chosen:** Benchmark data network effect
**Rationale:** Every eval run generates cross-company data: which APIs agents succeed/fail on, which doc patterns cause confusion, which SDK designs work. Over time, build anonymized leaderboards and benchmarks. The data moat compounds — each new customer makes the benchmark more valuable. No single API company can replicate this dataset.

### Decision 23: Success metric
**Chosen:** Re-run rate + report share rate
**Rationale:** Primary: % of users who run a second eval within 7 days (target: 30%+). Secondary: % of reports viewed by someone other than the creator. Re-run = the report drove action. Share = the report drove conversation. Together they prove the report is the product.

### Decision 24: What to build second
**Chosen:** CI integration (GitHub Action)
**Rationale:** A GitHub Action that runs the eval on every docs/SDK PR. "Your PR broke agent integration." This transforms Kiln from a one-off diagnostic into continuous monitoring — the "Sentry" upgrade. Also the natural pricing trigger: CI integration is a team feature worth paying for.

---

### Implementation Notes

### Repository structure
```
packages/
  web/          — Next.js 14+ app (App Router)
  runner/       — Agent orchestration + Firecracker sandbox management
  grader/       — Assertion runner (shell + LLM judge)
  shared/       — TypeScript types, DB schema, shared utilities
```

### Key files to create

**`packages/web/`**
- `app/page.tsx` — Landing / onboarding (D14)
- `app/auth/github/` — GitHub OAuth callback (D8)
- `app/evals/new/` — Multi-step eval creation form (D10, D15, D16)
- `app/reports/[id]/page.tsx` — Report page with sticky summary + verdicts + timeline (D6, D9)
- `app/reports/[id]/diff/page.tsx` — Side-by-side run comparison (D17)
- `app/reports/[id]/og/route.tsx` — Dynamic OG image generation (D13)
- `app/api/evals/` — Eval CRUD + job enqueue endpoints (D4)
- `app/api/events/` — SSE endpoint for live execution streaming (D11)

**`packages/runner/`**
- `src/agents/interface.ts` — Pluggable agent interface definition (D3)
- `src/agents/claude-code.ts` — Claude Code CLI adapter
- `src/agents/codex.ts` — Codex CLI adapter (stub)
- `src/sandbox/firecracker.ts` — Firecracker microVM lifecycle management (D2)
- `src/context/crawler.ts` — URL crawling with depth control (D15)
- `src/context/github.ts` — GitHub repo cloning + file selection (D15)
- `src/worker.ts` — BullMQ job consumer

**`packages/grader/`**
- `src/assertions/shell.ts` — Shell command assertion runner (D5)
- `src/assertions/http.ts` — HTTP endpoint check (D16)
- `src/assertions/file.ts` — File exists / file contains (D16)
- `src/assertions/llm-judge.ts` — LLM-as-judge evaluation (D5)
- `src/grader.ts` — Orchestrates all assertions, produces verdict array

**`packages/shared/`**
- `src/db/schema.ts` — Postgres schema (users, evals, runs, verdicts)
- `src/types.ts` — Shared TypeScript types (EvalConfig, RunResult, Verdict, AgentEvent)
- `src/s3.ts` — S3 client for trace/asset storage (D7)

### Database schema (core tables)
- `users` — GitHub ID, login, avatar, created_at
- `evals` — id (UUID), user_id, config (JSONB), created_at, share_token
- `runs` — id (UUID), eval_id, agent_type, status (pending/running/completed/errored), started_at, finished_at, trace_s3_key, error_type (null/platform/timeout)
- `verdicts` — id, run_id, assertion_index, type (shell/http/file/llm), passed (bool), output (text), hint (text)

### Infrastructure
- **Postgres** — managed (e.g., Neon, RDS, or Supabase Postgres)
- **S3** — AWS S3 or S3-compatible (R2, MinIO)
- **Redis** — BullMQ job queue between web and runner
- **Firecracker** — self-hosted on bare-metal or metal instances (e.g., Hetzner, AWS i3/metal)

### Verification plan
1. **Unit tests:** Grader assertion runners (shell, HTTP, file, LLM) with mock sandbox output
2. **Integration test:** Full eval flow — create eval via API, enqueue job, run agent in sandbox, grade, verify report renders
3. **E2E test:** GitHub OAuth → create eval via form → run → verify report page loads with correct verdicts
4. **Manual QA:** Run a real eval against a public API (e.g., Resend email API), verify the report is accurate and shareable
5. **OG preview test:** Paste report URL into Slack, verify the unfurl shows pass/fail + score + task name
6. **Error state test:** Force a sandbox timeout, verify the platform-error UI renders (not a red failure report)
7. **Diff test:** Run the same eval twice, verify the comparison view shows correct FIXED/REGRESSED tags

### Preview

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kiln — Agent Integration Eval Platform</title>
<style>
:root {
  --bg-root: #09090b;
  --bg-surface: #18181b;
  --bg-elevated: #1c1c1e;
  --bg-input: #18181b;
  --border: #27272a;
  --border-focus: #3f3f46;
  --text-primary: #fafafa;
  --text-secondary: #a1a1aa;
  --text-muted: #71717a;
  --text-dim: #52525b;
  --green: #22c55e;
  --green-bg: #1a2e1a;
  --red: #dc2626;
  --red-bg: #2a1215;
  --red-border: #7f1d1d;
  --red-light: #fca5a5;
  --yellow: #eab308;
  --yellow-border: #854d0e;
  --yellow-bg: #2a2017;
  --blue: #2563eb;
  --blue-bg: rgba(37, 99, 235, 0.13);
  --blue-light: #93c5fd;
  --purple-light: #c4b5fd;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
  --font-mono: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-full: 999px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: var(--font-sans);
  background: var(--bg-root);
  color: var(--text-primary);
  container-type: inline-size;
  container-name: plan-preview;
  min-height: 100vh;
}

.app-wrapper {
  max-width: 960px;
  margin: 0 auto;
  padding: 0;
}

/* ── NAV ── */
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
  position: sticky;
  top: 0;
  z-index: 100;
}
.nav-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.3px;
}
.nav-brand svg { flex-shrink: 0; }
.nav-links {
  display: flex;
  align-items: center;
  gap: 6px;
}
.nav-link {
  font-size: 12px;
  color: var(--text-muted);
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}
.nav-link:hover { background: var(--bg-elevated); color: var(--text-secondary); }
.nav-link.active { color: var(--text-primary); background: var(--bg-elevated); }
.nav-user {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--blue);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

/* ── TABS ── */
.screen { display: none; }
.screen.active { display: block; }

/* ── REPORT PAGE (D6, D9, D11, D12, D17, D18) ── */
.report-sticky {
  position: sticky;
  top: 49px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
  padding: 14px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  z-index: 50;
  flex-wrap: wrap;
  gap: 8px;
}
.report-sticky-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.badge {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: var(--radius-sm);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  white-space: nowrap;
}
.badge-fail { background: var(--red); color: white; }
.badge-pass { background: var(--green); color: white; }
.badge-error { background: var(--yellow); color: var(--bg-root); }
.report-title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 320px;
}
.report-meta {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}
.report-actions {
  display: flex;
  gap: 8px;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  padding: 7px 14px;
  border-radius: var(--radius-md);
  border: none;
  cursor: pointer;
  font-family: var(--font-sans);
  transition: background 0.15s, opacity 0.15s;
  white-space: nowrap;
}
.btn-primary { background: var(--blue); color: white; }
.btn-primary:hover { opacity: 0.9; }
.btn-ghost { background: var(--bg-elevated); color: var(--text-secondary); border: 1px solid var(--border); }
.btn-ghost:hover { background: var(--border); color: var(--text-primary); }

.report-body { padding: 20px; }

/* Stats grid */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 24px;
}
.stat-card {
  background: var(--bg-elevated);
  border-radius: var(--radius-md);
  padding: 14px;
}
.stat-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}
.stat-value {
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

@container plan-preview (max-width: 520px) {
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .report-title { max-width: 180px; }
}

/* Verdicts */
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}
.verdicts { display: flex; flex-direction: column; gap: 6px; margin-bottom: 28px; }
.verdict-row {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-elevated);
  padding: 10px 14px;
  border-radius: var(--radius-md);
  font-size: 13px;
}
.verdict-row.fail {
  background: var(--red-bg);
  border: 1px solid var(--red-border);
}
.verdict-icon { font-size: 15px; flex-shrink: 0; }
.verdict-name { flex: 1; }
.verdict-hint {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--border);
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
}
.verdict-llm {
  font-size: 10px;
  color: var(--purple-light);
  background: rgba(196, 181, 253, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
}

/* Timeline */
.timeline {
  border-left: 2px solid var(--border);
  margin-left: 8px;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-bottom: 28px;
}
.tl-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  position: relative;
}
.tl-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--green);
  position: absolute;
  left: -25px;
  top: 5px;
  flex-shrink: 0;
}
.tl-dot.fail {
  width: 10px;
  height: 10px;
  background: var(--red);
  left: -26px;
  top: 4px;
  border: 2px solid var(--red-border);
}
.tl-dot.active {
  width: 10px;
  height: 10px;
  background: var(--yellow);
  left: -26px;
  top: 4px;
  border: 2px solid var(--yellow-border);
  animation: pulse-dot 1.5s ease-in-out infinite;
}
@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.tl-time {
  font-size: 12px;
  color: var(--text-dim);
  min-width: 30px;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
}
.tl-text { font-size: 13px; }
.tl-text.fail { color: var(--red-light); font-weight: 500; }
.tl-annotation {
  margin-top: 6px;
  margin-left: 38px;
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  border-left: 3px solid var(--red);
}
.tl-annotation strong { color: var(--red-light); }
.tl-more {
  font-size: 12px;
  color: var(--text-dim);
  padding: 4px 0;
  cursor: pointer;
}
.tl-more:hover { color: var(--text-secondary); }

/* ── DIFF VIEW (D17) ── */
.diff-header {
  padding: 20px;
  border-bottom: 1px solid var(--border);
}
.diff-header h2 {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 4px;
}
.diff-header p { font-size: 13px; color: var(--text-muted); }
.diff-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
}
@container plan-preview (max-width: 520px) {
  .diff-grid { grid-template-columns: 1fr; }
}
.diff-col {
  padding: 16px 20px;
  border-right: 1px solid var(--border);
}
.diff-col:last-child { border-right: none; }
.diff-col-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.diff-col-label {
  font-size: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.diff-col-date { font-size: 11px; color: var(--text-dim); }
.diff-verdict-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  margin-bottom: 4px;
}
.diff-verdict-row.pass { background: rgba(34, 197, 94, 0.08); }
.diff-verdict-row.fail { background: var(--red-bg); }
.diff-verdict-row.flipped {
  border: 1px solid var(--green);
  background: rgba(34, 197, 94, 0.08);
}
.flip-tag {
  font-size: 10px;
  font-weight: 600;
  color: var(--green);
  background: rgba(34, 197, 94, 0.15);
  padding: 1px 6px;
  border-radius: 3px;
  margin-left: auto;
  white-space: nowrap;
}

/* ── FORM (D4, D10, D15, D16) ── */
.form-wrapper { padding: 24px 20px; }
.form-header {
  margin-bottom: 28px;
}
.form-header h2 { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
.form-header p { font-size: 13px; color: var(--text-muted); }

/* Stepper */
.stepper {
  display: flex;
  align-items: center;
  gap: 0;
  margin-bottom: 28px;
  overflow-x: auto;
}
.step {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.step-num {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}
.step.active .step-num { background: var(--blue); color: white; }
.step.done .step-num { background: var(--green); color: white; }
.step.pending .step-num { background: var(--border); color: var(--text-muted); }
.step-label { font-size: 12px; font-weight: 500; }
.step.active .step-label { color: var(--blue-light); }
.step.done .step-label { color: var(--text-secondary); }
.step.pending .step-label { color: var(--text-muted); }
.step-line {
  flex: 1;
  min-width: 16px;
  height: 1px;
  background: var(--border);
  margin: 0 10px;
}

/* Form fields */
.field { margin-bottom: 20px; }
.field-label {
  font-size: 13px;
  font-weight: 600;
  display: block;
  margin-bottom: 6px;
}
.field-hint {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 4px;
}
textarea.input, input.input {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  color: var(--text-primary);
  font-size: 13px;
  font-family: var(--font-sans);
  resize: vertical;
  outline: none;
  transition: border-color 0.15s;
}
textarea.input:focus, input.input:focus { border-color: var(--blue); }
textarea.input { min-height: 80px; }

/* Language picker */
.lang-picker { display: flex; gap: 8px; flex-wrap: wrap; }
.lang-chip {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 7px 16px;
  font-size: 13px;
  color: var(--text-muted);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.lang-chip:hover { border-color: var(--border-focus); color: var(--text-secondary); }
.lang-chip.selected {
  background: var(--blue-bg);
  border-color: var(--blue);
  color: var(--text-primary);
}

/* Context ingestion (D15) */
.context-sources {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}
.context-source {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px 14px;
}
.ctx-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  flex-shrink: 0;
}
.ctx-badge.url { background: var(--blue-bg); color: var(--blue-light); }
.ctx-badge.repo { background: rgba(196, 181, 253, 0.1); color: var(--purple-light); }
.ctx-badge.file { background: var(--green-bg); color: var(--green); }
.ctx-name { font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx-remove { color: var(--text-dim); cursor: pointer; font-size: 16px; flex-shrink: 0; }
.ctx-remove:hover { color: var(--text-secondary); }
.context-add-btns {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.ctx-add-btn {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 7px 12px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: border-color 0.15s, color 0.15s;
}
.ctx-add-btn:hover { border-color: var(--border-focus); color: var(--text-secondary); }
.ctx-add-btn .plus { color: var(--blue-light); }
.context-preview {
  margin-top: 12px;
  background: var(--bg-elevated);
  border-radius: var(--radius-md);
  padding: 10px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-muted);
}

/* Assertion authoring (D16) */
.assertions { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.assertion-row {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px 14px;
}
.assert-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}
.assert-badge.http { background: rgba(37, 99, 235, 0.15); color: var(--blue-light); }
.assert-badge.file { background: var(--green-bg); color: var(--green); }
.assert-badge.shell { background: var(--yellow-bg); color: var(--yellow); }
.assert-badge.llm { background: rgba(196, 181, 253, 0.1); color: var(--purple-light); }
.assert-text { font-size: 12px; flex: 1; }
.assert-text code {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
}
.assertion-templates {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.tmpl-btn {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 7px 12px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: border-color 0.15s, color 0.15s;
}
.tmpl-btn:hover { border-color: var(--border-focus); color: var(--text-secondary); }

/* Form nav */
.form-nav {
  display: flex;
  justify-content: space-between;
  margin-top: 28px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
}

/* ── PLATFORM ERROR (D18) ── */
.platform-error {
  margin: 20px;
  background: var(--bg-surface);
  border: 1px solid var(--yellow-border);
  border-radius: var(--radius-lg);
  padding: 28px;
  text-align: center;
}
.platform-error .badge { margin-bottom: 12px; display: inline-block; }
.platform-error h3 {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 6px;
}
.platform-error p {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 18px;
  max-width: 400px;
  margin-left: auto;
  margin-right: auto;
}

/* ── ONBOARDING (D14) ── */
.onboarding {
  padding: 40px 20px;
  text-align: center;
  max-width: 520px;
  margin: 0 auto;
}
.onboarding h1 {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 8px;
}
.onboarding .subtitle {
  font-size: 14px;
  color: var(--text-muted);
  margin-bottom: 32px;
  line-height: 1.5;
}
.onboarding-steps {
  display: flex;
  flex-direction: column;
  gap: 16px;
  text-align: left;
  margin-bottom: 32px;
}
.ob-step {
  display: flex;
  gap: 14px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 16px;
}
.ob-step-num {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-muted);
  flex-shrink: 0;
}
.ob-step-content h4 { font-size: 13px; font-weight: 600; margin-bottom: 3px; }
.ob-step-content p { font-size: 12px; color: var(--text-muted); line-height: 1.4; }

/* ── SHARE CONFIG (D19) ── */
.share-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 8px 12px;
  margin: 0 20px 20px;
}
.share-bar input {
  flex: 1;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: var(--font-mono);
  outline: none;
}
.share-bar .btn { flex-shrink: 0; }

/* Screen tabs */
.screen-tabs {
  display: flex;
  gap: 2px;
  padding: 8px 20px;
  background: var(--bg-root);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}
.screen-tab {
  font-size: 11px;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-muted);
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
  border: none;
  background: none;
  font-family: var(--font-sans);
}
.screen-tab:hover { background: var(--bg-surface); color: var(--text-secondary); }
.screen-tab.active { background: var(--bg-surface); color: var(--text-primary); }

/* free tier banner (D20) */
.free-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px;
  background: rgba(37, 99, 235, 0.08);
  border-bottom: 1px solid rgba(37, 99, 235, 0.15);
  font-size: 11px;
  color: var(--blue-light);
}
.free-banner strong { font-weight: 600; }
</style>
</head>
<body>

<div class="app-wrapper">

<!-- Free tier banner (D20) -->
<div class="free-banner" data-decision="20">
  <span>Free plan — <strong>7 of 10</strong> evals remaining this month</span>
</div>

<!-- Nav -->
<nav class="nav" data-decision="8">
  <div class="nav-brand">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="6" fill="#2563eb"/>
      <path d="M7 12l3 3 7-7" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    Kiln
  </div>
  <div class="nav-links">
    <button class="nav-link screen-tab active" data-screen="report">Report</button>
    <button class="nav-link screen-tab" data-screen="diff">Diff</button>
    <button class="nav-link screen-tab" data-screen="create">New Eval</button>
    <button class="nav-link screen-tab" data-screen="onboarding">Onboarding</button>
    <button class="nav-link screen-tab" data-screen="error">Error</button>
    <div class="nav-user">JK</div>
  </div>
</nav>

<!-- ════════════ SCREEN: REPORT ════════════ -->
<div class="screen active" id="screen-report" data-decision="6">

  <!-- Sticky summary (D9) -->
  <div class="report-sticky" data-decision="9">
    <div class="report-sticky-left">
      <span class="badge badge-fail">FAILED</span>
      <span class="report-title">Acme Payments SDK — Checkout Integration</span>
      <span class="report-meta">2m 34s · Claude Code · Jun 1, 2026</span>
    </div>
    <div class="report-actions">
      <button class="btn btn-ghost" data-decision="19">Share</button>
      <button class="btn btn-primary" data-decision="17">Re-run Eval</button>
    </div>
  </div>

  <!-- Share bar (D19) -->
  <div class="share-bar" data-decision="19">
    <input type="text" value="https://kiln.dev/report/a3f9c2e1-8b47-4d2a" readonly />
    <button class="btn btn-ghost" style="padding: 5px 10px; font-size: 11px;">Copy</button>
  </div>

  <div class="report-body">

    <!-- Stats (D9) -->
    <div class="stats-grid" data-decision="9">
      <div class="stat-card">
        <div class="stat-label">Tests</div>
        <div class="stat-value"><span style="color: var(--green);">3</span> <span style="color: var(--text-dim);">/</span> 5</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Agent Steps</div>
        <div class="stat-value">17</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Duration</div>
        <div class="stat-value">2:34</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Tokens</div>
        <div class="stat-value">48k</div>
      </div>
    </div>

    <!-- Verdicts (D5, D6) -->
    <div class="section-title">Test Verdicts</div>
    <div class="verdicts" data-decision="5">
      <div class="verdict-row">
        <span class="verdict-icon" style="color: var(--green);">✓</span>
        <span class="verdict-name">SDK installed correctly</span>
      </div>
      <div class="verdict-row">
        <span class="verdict-icon" style="color: var(--green);">✓</span>
        <span class="verdict-name">API client initialized with auth</span>
      </div>
      <div class="verdict-row">
        <span class="verdict-icon" style="color: var(--green);">✓</span>
        <span class="verdict-name">Payment intent created</span>
      </div>
      <div class="verdict-row fail">
        <span class="verdict-icon" style="color: var(--red);">✗</span>
        <span class="verdict-name">Webhook handler registered</span>
        <span class="verdict-hint">agent looped on docs</span>
      </div>
      <div class="verdict-row fail">
        <span class="verdict-icon" style="color: var(--red);">✗</span>
        <span class="verdict-name">Code follows SDK patterns</span>
        <span class="verdict-llm">LLM judge</span>
        <span class="verdict-hint">wrong method signature</span>
      </div>
    </div>

    <!-- Timeline -->
    <div class="section-title">Execution Timeline</div>
    <div class="timeline" data-decision="11">
      <div class="tl-item">
        <div class="tl-dot"></div>
        <span class="tl-time">0:00</span>
        <span class="tl-text">Installed acme-payments-sdk@3.2.1</span>
      </div>
      <div class="tl-item">
        <div class="tl-dot"></div>
        <span class="tl-time">0:12</span>
        <span class="tl-text">Created client with API key</span>
      </div>
      <div class="tl-item">
        <div class="tl-dot"></div>
        <span class="tl-time">0:38</span>
        <span class="tl-text">Called createPaymentIntent — 200 OK</span>
      </div>
      <div class="tl-item">
        <div class="tl-dot fail"></div>
        <span class="tl-time">0:52</span>
        <span class="tl-text fail">Read webhook docs 4 times — looped without progress</span>
      </div>
      <div class="tl-annotation">
        <strong>Why it failed:</strong> The webhook setup docs reference <code style="background: var(--border); padding: 1px 5px; border-radius: 3px; font-family: var(--font-mono); font-size: 11px;">registerEndpoint()</code> but the SDK exports <code style="background: var(--border); padding: 1px 5px; border-radius: 3px; font-family: var(--font-mono); font-size: 11px;">webhooks.listen()</code>. The agent couldn't reconcile the mismatch.
      </div>
      <div class="tl-item">
        <div class="tl-dot"></div>
        <span class="tl-time">1:45</span>
        <span class="tl-text">Attempted manual webhook setup with express</span>
      </div>
      <div class="tl-more">⋯ 12 more steps</div>
    </div>
  </div>
</div>

<!-- ════════════ SCREEN: DIFF (D17) ════════════ -->
<div class="screen" id="screen-diff" data-decision="17">
  <div class="diff-header">
    <h2>Run Comparison</h2>
    <p>Acme Payments SDK — Checkout Integration</p>
  </div>
  <div class="diff-grid">
    <div class="diff-col">
      <div class="diff-col-header">
        <span class="diff-col-label">Previous Run</span>
        <span class="diff-col-date">Jun 1, 2:30pm</span>
      </div>
      <div class="diff-verdict-row pass"><span style="color: var(--green); font-size: 14px;">✓</span> SDK installed</div>
      <div class="diff-verdict-row pass"><span style="color: var(--green); font-size: 14px;">✓</span> Client initialized</div>
      <div class="diff-verdict-row pass"><span style="color: var(--green); font-size: 14px;">✓</span> Payment intent</div>
      <div class="diff-verdict-row fail"><span style="color: var(--red); font-size: 14px;">✗</span> Webhook handler</div>
      <div class="diff-verdict-row fail"><span style="color: var(--red); font-size: 14px;">✗</span> E2E checkout</div>
      <div style="margin-top: 14px;">
        <span class="badge badge-fail" style="font-size: 10px;">3/5 PASSED</span>
      </div>
    </div>
    <div class="diff-col">
      <div class="diff-col-header">
        <span class="diff-col-label">Latest Run</span>
        <span class="diff-col-date">Jun 2, 10:15am</span>
      </div>
      <div class="diff-verdict-row pass"><span style="color: var(--green); font-size: 14px;">✓</span> SDK installed</div>
      <div class="diff-verdict-row pass"><span style="color: var(--green); font-size: 14px;">✓</span> Client initialized</div>
      <div class="diff-verdict-row pass"><span style="color: var(--green); font-size: 14px;">✓</span> Payment intent</div>
      <div class="diff-verdict-row flipped"><span style="color: var(--green); font-size: 14px;">✓</span> Webhook handler <span class="flip-tag">FIXED</span></div>
      <div class="diff-verdict-row flipped"><span style="color: var(--green); font-size: 14px;">✓</span> E2E checkout <span class="flip-tag">FIXED</span></div>
      <div style="margin-top: 14px;">
        <span class="badge badge-pass" style="font-size: 10px;">5/5 PASSED</span>
      </div>
    </div>
  </div>
  <div style="padding: 16px 20px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-muted);">
    <strong style="color: var(--green);">+2 tests fixed</strong> after updating webhook docs to reference <code style="font-family: var(--font-mono); font-size: 11px; background: var(--border); padding: 1px 5px; border-radius: 3px;">webhooks.listen()</code>
  </div>
</div>

<!-- ════════════ SCREEN: CREATE EVAL (D4, D10, D15, D16) ════════════ -->
<div class="screen" id="screen-create" data-decision="10">
  <div class="form-wrapper">
    <div class="form-header">
      <h2>New Eval</h2>
      <p>Define what the agent should build, give it context, and set pass/fail tests.</p>
    </div>

    <!-- Stepper (D10) -->
    <div class="stepper">
      <div class="step done">
        <div class="step-num">✓</div>
        <span class="step-label">Task</span>
      </div>
      <div class="step-line"></div>
      <div class="step active" id="step-context">
        <div class="step-num">2</div>
        <span class="step-label">Context</span>
      </div>
      <div class="step-line"></div>
      <div class="step pending" id="step-tests">
        <div class="step-num">3</div>
        <span class="step-label">Tests</span>
      </div>
      <div class="step-line"></div>
      <div class="step pending">
        <div class="step-num">4</div>
        <span class="step-label">Run</span>
      </div>
    </div>

    <!-- Step 2: Context (D15) -->
    <div id="form-step-context" data-decision="15">
      <div class="field">
        <label class="field-label">Context sources</label>
        <div class="field-hint" style="margin-bottom: 10px;">Add the docs, SDK files, and examples the agent should use.</div>
        <div class="context-sources">
          <div class="context-source">
            <span class="ctx-badge url">URL</span>
            <span class="ctx-name">https://docs.acme.dev/payments/quickstart</span>
            <span class="ctx-remove">×</span>
          </div>
          <div class="context-source">
            <span class="ctx-badge repo">REPO</span>
            <span class="ctx-name">github.com/acme/payments-sdk — /src, /examples</span>
            <span class="ctx-remove">×</span>
          </div>
          <div class="context-source">
            <span class="ctx-badge file">FILE</span>
            <span class="ctx-name">webhook-examples.ts (uploaded)</span>
            <span class="ctx-remove">×</span>
          </div>
        </div>
        <div class="context-add-btns">
          <button class="ctx-add-btn"><span class="plus">+</span> Crawl URL</button>
          <button class="ctx-add-btn"><span class="plus">+</span> GitHub Repo</button>
          <button class="ctx-add-btn"><span class="plus">+</span> Upload Files</button>
          <button class="ctx-add-btn"><span class="plus">+</span> Paste Text</button>
        </div>
        <div class="context-preview">
          <span>Agent will see 3 sources · ~12,400 tokens</span>
          <span style="color: var(--green); font-size: 11px;">Preview →</span>
        </div>
      </div>
    </div>

    <!-- Step 3: Tests (D16) — shown below context for completeness -->
    <div id="form-step-tests" data-decision="16" style="margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--border);">
      <div class="field">
        <label class="field-label">Pass/fail assertions</label>
        <div class="field-hint" style="margin-bottom: 10px;">Define how to verify the agent's work.</div>
        <div class="assertions">
          <div class="assertion-row">
            <span class="assert-badge http">HTTP</span>
            <span class="assert-text">Server responds at localhost:3000/health</span>
            <span class="ctx-remove">×</span>
          </div>
          <div class="assertion-row">
            <span class="assert-badge file">FILE</span>
            <span class="assert-text">File exists: src/checkout.ts</span>
            <span class="ctx-remove">×</span>
          </div>
          <div class="assertion-row">
            <span class="assert-badge shell">SHELL</span>
            <span class="assert-text"><code>node test.js</code></span>
            <span class="ctx-remove">×</span>
          </div>
          <div class="assertion-row">
            <span class="assert-badge llm">LLM</span>
            <span class="assert-text">Code follows SDK recommended patterns</span>
            <span class="ctx-remove">×</span>
          </div>
        </div>
        <div class="assertion-templates">
          <button class="tmpl-btn"><span style="color: var(--blue-light);">+</span> HTTP check</button>
          <button class="tmpl-btn"><span style="color: var(--green);">+</span> File exists</button>
          <button class="tmpl-btn"><span style="color: var(--green);">+</span> File contains</button>
          <button class="tmpl-btn"><span style="color: var(--yellow);">+</span> Shell command</button>
          <button class="tmpl-btn"><span style="color: var(--purple-light);">+</span> LLM judge</button>
        </div>
      </div>
    </div>

    <div class="form-nav">
      <button class="btn btn-ghost">← Back: Task</button>
      <button class="btn btn-primary">Next: Review & Run →</button>
    </div>
  </div>
</div>

<!-- ════════════ SCREEN: ONBOARDING (D14) ════════════ -->
<div class="screen" id="screen-onboarding" data-decision="14">
  <div class="onboarding">
    <h1>Welcome to Kiln</h1>
    <p class="subtitle">Test whether coding agents can successfully integrate your API. Run real agents, grade the results, see exactly where they fail.</p>

    <div class="onboarding-steps">
      <div class="ob-step">
        <div class="ob-step-num">1</div>
        <div class="ob-step-content">
          <h4>Define a task</h4>
          <p>Describe a realistic integration task — "Build a checkout flow using our Payments SDK."</p>
        </div>
      </div>
      <div class="ob-step">
        <div class="ob-step-num">2</div>
        <div class="ob-step-content">
          <h4>Add your context</h4>
          <p>Link your docs, SDK repo, or upload example files. This is what the agent sees.</p>
        </div>
      </div>
      <div class="ob-step">
        <div class="ob-step-num">3</div>
        <div class="ob-step-content">
          <h4>Set pass/fail tests</h4>
          <p>Define assertions: HTTP checks, file existence, shell commands, or LLM-judged criteria.</p>
        </div>
      </div>
      <div class="ob-step">
        <div class="ob-step-num">4</div>
        <div class="ob-step-content">
          <h4>Get your report</h4>
          <p>We run the agent in an isolated sandbox, grade the output, and give you a shareable report URL showing exactly where the agent succeeded or failed.</p>
        </div>
      </div>
    </div>

    <button class="btn btn-primary" style="padding: 12px 32px; font-size: 14px;" onclick="switchScreen('create')">Create Your First Eval →</button>
    <p style="font-size: 12px; color: var(--text-dim); margin-top: 12px;">Free plan — 10 evals/month, no credit card required</p>
  </div>
</div>

<!-- ════════════ SCREEN: PLATFORM ERROR (D18) ════════════ -->
<div class="screen" id="screen-error" data-decision="18">
  <div class="report-sticky" style="top: 49px;">
    <div class="report-sticky-left">
      <span class="badge badge-error">PLATFORM ERROR</span>
      <span class="report-title">Acme Payments SDK — Checkout Integration</span>
    </div>
  </div>
  <div class="platform-error">
    <span class="badge badge-error" style="font-size: 13px;">⚠ Platform Issue</span>
    <h3>Eval couldn't complete</h3>
    <p>The sandbox timed out after 5 minutes. This is a platform issue, not a problem with your API or docs. This run won't count toward your monthly limit.</p>
    <div style="display: flex; gap: 8px; justify-content: center;">
      <button class="btn btn-primary">Retry (free)</button>
      <button class="btn btn-ghost">View Partial Trace</button>
    </div>
  </div>
</div>

</div><!-- /app-wrapper -->

<script>
function switchScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.screen-tab').forEach(t => t.classList.remove('active'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.add('active');
  document.querySelectorAll('.screen-tab').forEach(t => {
    if (t.dataset.screen === id) t.classList.add('active');
  });
}
document.querySelectorAll('.screen-tab').forEach(tab => {
  tab.addEventListener('click', () => switchScreen(tab.dataset.screen));
});
</script>

</body>
</html>
```

### Metadata

- Source plan: `tcyZIGN2ZwxpaKDC08KE-`
- Resolved decisions: 24
- Generated at: 2026-06-02T03:09:07.881Z