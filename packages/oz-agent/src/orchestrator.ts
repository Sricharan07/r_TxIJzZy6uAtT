import { randomUUID } from "node:crypto";
import type { KilnStore } from "@kiln/shared/store";
import type { OzAgentState, OzEvent, OzEventKind, OzJob, OzJobStatus, OzMode } from "@kiln/shared";
import { runAssertionEngineerAgent } from "./agents/assertion-engineer-agent.js";
import { runDocsResearchAgent } from "./agents/docs-research-agent.js";
import { runDocsMapperAgent, type DocsMapItem } from "./agents/docs-mapper-agent.js";
import { runProductAnalystAgent } from "./agents/product-analyst-agent.js";
import { runSafetyAgent } from "./agents/safety-agent.js";
import { runScoutAgent } from "./agents/scout-agent.js";
import { runSuiteCriticAgent } from "./agents/suite-critic-agent.js";
import { runTestArchitectAgent } from "./agents/test-architect-agent.js";
import type { OzToolContext } from "./tools/contracts.js";

export interface CreateOzJobInput {
  userId: string;
  productUrl: string;
  mode?: OzMode;
  userGoal?: string;
  preferredLanguage?: OzAgentState["input"]["preferredLanguage"];
  agentTargets?: OzAgentState["input"]["agentTargets"];
}

export interface OzOrchestratorOptions {
  store: KilnStore;
  fetchImpl?: typeof fetch;
}

class OzJobStoppedError extends Error {
  constructor() {
    super("Oz job was stopped.");
  }
}

function initialState(input: CreateOzJobInput, jobId = randomUUID()): OzAgentState {
  return {
    jobId,
    userId: input.userId,
    input: {
      productUrl: input.productUrl,
      userGoal: input.userGoal,
      preferredLanguage: input.preferredLanguage,
      agentTargets: input.agentTargets,
      mode: input.mode ?? "copilot",
    },
    discovery: {
      docsCandidates: [],
      selectedDocs: [],
      githubRepos: [],
      packages: [],
      codeExamples: [],
    },
    approval: { status: "pending" },
  };
}

export class OzOrchestrator {
  constructor(private readonly options: OzOrchestratorOptions) {}

  async createJob(input: CreateOzJobInput): Promise<OzJob> {
    const state = initialState(input);
    const job = await this.options.store.createOzJob(input.userId, input.productUrl, state.input.mode, state);
    await this.emit(job, "discovery.started", "Oz job created. Discovery is ready to start.");
    return job;
  }

  async runToApproval(jobId: string): Promise<OzJob> {
    let job = await this.requireJob(jobId);
    try {
      job = await this.setStatus(job, "discovering");
      await this.emit(job, "discovery.started", "Oz is finding docs, SDKs, repos, examples, auth pages, and webhook pages.");
      job.state = await runScoutAgent(job.state, this.toolContext(job));
      await this.save(job);
      for (const docs of job.state.discovery.docsCandidates.slice(0, 5)) {
        await this.emit(job, "docs.found", `Found docs candidate: ${docs.label}`, { url: docs.url, confidence: docs.confidence });
      }
      for (const pkg of job.state.discovery.packages.slice(0, 4)) {
        await this.emit(job, "package.found", `Found ${pkg.manager} package: ${pkg.name}`, {
          packageName: pkg.name,
          manager: pkg.manager,
        });
      }
      await this.artifact(job, "crawled_pages", "Selected docs", job.state.discovery.selectedDocs);

      job = await this.setStatus(job, "profiling");
      job.state = await runProductAnalystAgent(job.state, this.toolContext(job));
      await this.save(job);
      await this.emit(job, "profile.updated", `Oz understood ${job.state.productProfile?.productName ?? "the product"}.`, {
        profile: job.state.productProfile,
      });
      await this.artifact(job, "product_profile", "Product Intelligence", job.state.productProfile);

      job.state = await runDocsResearchAgent(job.state, this.toolContext(job));
      await this.save(job);
      await this.artifact(job, "research_report", "Docs research report", job.state.research);
      for (const conflict of job.state.research?.conflicts ?? []) {
        await this.emit(job, "finding.created", conflict.title, {
          conflictId: conflict.id,
          category: conflict.category,
          severity: conflict.severity,
          status: conflict.status,
        });
      }

      job = await this.setStatus(job, "mapping_docs");
      const mapped = await runDocsMapperAgent(job.state);
      job.state = mapped.state;
      await this.save(job);
      await this.artifact(job, "docs_map", "Docs map", mapped.docsMap);
      await this.emit(job, "profile.updated", `Mapped ${mapped.docsMap.length} documentation surfaces.`, { docsMap: mapped.docsMap });

      job = await this.setStatus(job, "generating_suite");
      job.state = await runTestArchitectAgent(job.state, this.toolContext(job));
      job.state = await runAssertionEngineerAgent(job.state, this.toolContext(job));
      await this.save(job);
      for (const scenario of job.state.suiteDraft?.scenarios ?? []) {
        await this.emit(job, "scenario.generated", `Generated scenario: ${scenario.title}`, { scenarioId: scenario.id });
      }

      job = await this.setStatus(job, "critiquing_suite");
      job.state = await runSafetyAgent(job.state, this.toolContext(job));
      job.state = await runSuiteCriticAgent(job.state, this.toolContext(job));
      await this.save(job);
      const riskCount = job.state.suiteDraft?.risks.length ?? 0;
      await this.emit(job, "suite.critiqued", `Suite critic and safety review found ${riskCount} issue${riskCount === 1 ? "" : "s"}.`, {
        issuesFound: riskCount,
      });
      await this.artifact(job, "suite_draft", "Generated suite", job.state.suiteDraft);

      const nextStatus: OzJobStatus = job.state.verification?.schemaValid ? "awaiting_approval" : "blocked";
      job = await this.setStatus(job, nextStatus);
      await this.emit(
        job,
        nextStatus === "awaiting_approval" ? "suite.ready" : "job.blocked",
        nextStatus === "awaiting_approval"
          ? "Oz verified the suite and is waiting for approval."
          : "Oz could not verify the generated suite without user edits.",
        { verification: job.state.verification },
      );
      return job;
    } catch (err) {
      if (err instanceof OzJobStoppedError) return this.requireJob(jobId);
      job = await this.setStatus(job, "failed");
      await this.emit(job, "job.failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private toolContext(job: OzJob): OzToolContext {
    return {
      jobId: job.id,
      userId: job.userId,
      store: this.options.store,
      fetchImpl: this.options.fetchImpl,
    };
  }

  private async requireJob(jobId: string): Promise<OzJob> {
    const job = await this.options.store.getOzJob(jobId);
    if (!job) throw new Error(`Oz job ${jobId} was not found.`);
    return job;
  }

  private async save(job: OzJob): Promise<OzJob> {
    const current = await this.requireJob(job.id);
    if (current.status === "stopped") throw new OzJobStoppedError();
    await this.options.store.saveOzJob(job);
    return (await this.requireJob(job.id));
  }

  private async setStatus(job: OzJob, status: OzJobStatus): Promise<OzJob> {
    const current = await this.requireJob(job.id);
    if (current.status === "stopped") throw new OzJobStoppedError();
    const next = { ...job, status, state: { ...job.state } };
    await this.options.store.saveOzJob(next);
    return this.requireJob(job.id);
  }

  private async emit(job: OzJob, kind: OzEventKind, message: string, payload?: Record<string, unknown>): Promise<OzEvent> {
    return this.options.store.appendOzEvent({
      jobId: job.id,
      kind,
      phase: job.status,
      message,
      payload,
    });
  }

  private async artifact(job: OzJob, type: string, name: string, data: unknown): Promise<void> {
    await this.options.store.createOzArtifact(job.id, type, name, data);
  }
}

export type { DocsMapItem };
