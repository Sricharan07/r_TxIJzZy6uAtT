"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  AgentType,
  Assertion,
  AssertionType,
  ContextSource,
  ContextSourceType,
  Language,
  ProductCommandStep,
  ProductEnvRequirement,
  ProductEnvScope,
  ProductPackage,
  ProductProfile,
  ProductRuntimeImage,
  ProductType,
} from "@kiln/shared";

const LANGUAGES: { value: Language; label: string }[] = [
  { value: "node", label: "Node.js" },
  { value: "python", label: "Python" },
  { value: "go", label: "Go" },
  { value: "other", label: "Other" },
];

const AGENTS: { value: AgentType; label: string }[] = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
];

const PRODUCT_TYPES: { value: ProductType; label: string }[] = [
  { value: "sdk", label: "SDK" },
  { value: "api", label: "HTTP API" },
  { value: "cli", label: "CLI" },
  { value: "web-ui", label: "Web UI" },
  { value: "auth", label: "Auth" },
  { value: "payments", label: "Payments" },
  { value: "storage", label: "Storage" },
  { value: "ai-sdk", label: "AI SDK" },
  { value: "rag", label: "Retrieval" },
  { value: "database", label: "Database" },
  { value: "other", label: "Other" },
];

const RUNTIME_IMAGES: { value: ProductRuntimeImage; label: string }[] = [
  { value: "default", label: "Default guest" },
  { value: "ubuntu-22.04-node22", label: "Ubuntu 22.04 / Node 22" },
  { value: "ubuntu-24.04-node22", label: "Ubuntu 24.04 / Node 22" },
  { value: "python", label: "Python image" },
  { value: "go", label: "Go image" },
];

const STEP_LABELS = ["Product", "Access", "Docs", "Scenario", "Tests", "Run"];
const ENV_SCOPES: ProductEnvScope[] = ["setup", "agent", "assertion", "cleanup"];

const DEFAULT_PRODUCT: ProductProfile = {
  companyName: "Acme",
  productName: "Developer Platform",
  productType: "sdk",
  runtime: { language: "node", image: "default", nodeVersion: ">=20" },
  docsSources: [{ type: "url", label: "https://docs.example.com/quickstart", crawlDepth: "single" }],
  packages: [{ manager: "npm", name: "@acme/sdk", version: "latest" }],
  requiredEnv: [],
  setupSteps: [],
  preflightChecks: [],
  cleanupSteps: [],
};

const DEFAULT_ASSERTIONS: Assertion[] = [
  { type: "file", name: "Integration file exists", config: { path: "src/integration.ts" } },
  { type: "shell", name: "Project tests pass", config: { command: "npm test" } },
  {
    type: "llm",
    name: "Uses documented product APIs",
    config: { criterion: "The implementation uses the documented SDK/API patterns from the provided product docs." },
  },
];

const CTX_ADD: { type: ContextSourceType; label: string }[] = [
  { type: "url", label: "Docs URL" },
  { type: "repo", label: "GitHub Repo" },
  { type: "file", label: "Upload File" },
  { type: "paste", label: "Paste Text" },
];

const ASSERT_TEMPLATES: { type: AssertionType; label: string; name: string; config: Assertion["config"] }[] = [
  { type: "http", label: "HTTP", name: "HTTP endpoint returns 200", config: { url: "http://localhost:3000/", expectStatus: 200 } },
  { type: "file", label: "File", name: "File exists", config: { path: "src/integration.ts" } },
  { type: "file", label: "Contains", name: "File contains expected text", config: { path: "src/integration.ts", contains: "" } },
  { type: "shell", label: "Shell", name: "Command exits 0", config: { command: "npm test" } },
  { type: "llm", label: "Judge", name: "Follows docs", config: { criterion: "Implementation follows the provided product documentation." } },
];

function ctxBadgeClass(t: ContextSourceType): string {
  return t === "repo" ? "repo" : t === "file" || t === "paste" ? "file" : "url";
}

function packageSpecifier(pkg: ProductPackage): string {
  if (pkg.manager === "go") return pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;
  if (pkg.manager !== "npm" && pkg.manager !== "pip") return pkg.name;
  if (!pkg.version || pkg.version === "latest") return pkg.name;
  return pkg.manager === "npm" ? `${pkg.name}@${pkg.version}` : `${pkg.name}==${pkg.version}`;
}

function generatedSetupSteps(product: ProductProfile): ProductCommandStep[] {
  const packages = product.packages ?? [];
  const explicit = packages.filter((pkg) => pkg.installCommand);
  const npmPackages = packages.filter((pkg) => pkg.manager === "npm" && !pkg.installCommand);
  const pipPackages = packages.filter((pkg) => pkg.manager === "pip" && !pkg.installCommand);
  const goPackages = packages.filter((pkg) => pkg.manager === "go" && !pkg.installCommand);
  return [
    ...explicit.map((pkg): ProductCommandStep => ({
      name: `Install ${pkg.name}`,
      command: pkg.installCommand!,
    })),
    ...(npmPackages.length
      ? [
          {
            name: "Install npm packages",
            command: `npm init -y >/dev/null && npm install ${npmPackages.map(packageSpecifier).join(" ")}`,
          },
        ]
      : []),
    ...(pipPackages.length
      ? [
          {
            name: "Install Python packages",
            command: `python3 -m pip install ${pipPackages.map(packageSpecifier).join(" ")}`,
          },
        ]
      : []),
    ...(goPackages.length
      ? [
          {
            name: "Install Go packages",
            command: `go mod init kiln-product-eval 2>/dev/null || true; go get ${goPackages.map(packageSpecifier).join(" ")}`,
          },
        ]
      : []),
  ];
}

function generatedPreflightChecks(product: ProductProfile): ProductCommandStep[] {
  return (product.packages ?? [])
    .filter((pkg) => pkg.importCheck)
    .map((pkg): ProductCommandStep => ({
      name: `Import check: ${pkg.name}`,
      command: pkg.importCheck!,
    }));
}

function finalSetupSteps(product: ProductProfile): ProductCommandStep[] {
  return [...generatedSetupSteps(product), ...(product.setupSteps ?? [])];
}

function finalPreflightChecks(product: ProductProfile): ProductCommandStep[] {
  return [...generatedPreflightChecks(product), ...(product.preflightChecks ?? [])];
}

function templateFor(kind: "sdk" | "api" | "cli" | "rag"): {
  product: ProductProfile;
  task: string;
  assertions: Assertion[];
} {
  if (kind === "api") {
    return {
      product: {
        ...DEFAULT_PRODUCT,
        productName: "HTTP API",
        productType: "api",
        packages: [],
      },
      task: "Build a typed client for the product API, implement one realistic create/read workflow, and document the request and response handling.",
      assertions: [
        { type: "file", name: "API client exists", config: { path: "src/client.ts" } },
        { type: "shell", name: "TypeScript compiles", config: { command: "npm test || npm run build" } },
      ],
    };
  }
  if (kind === "cli") {
    return {
      product: {
        ...DEFAULT_PRODUCT,
        productName: "CLI Tool",
        productType: "cli",
        packages: [{ manager: "shell", name: "product-cli", installCommand: "echo 'Replace with CLI install command'" }],
      },
      task: "Install the product CLI, run a realistic workflow, capture the output, and create a small wrapper script for repeatable use.",
      assertions: [
        { type: "file", name: "CLI wrapper exists", config: { path: "scripts/product-workflow.sh" } },
        { type: "shell", name: "Wrapper is executable", config: { command: "test -x scripts/product-workflow.sh" } },
      ],
    };
  }
  if (kind === "rag") {
    return {
      product: {
        companyName: "Moss",
        productName: "Moss JS SDK",
        productType: "rag",
        runtime: { language: "node", image: "ubuntu-24.04-node22", nodeVersion: ">=20" },
        docsSources: [
          { type: "url", label: "https://docs.moss.dev/docs/reference/js/api", crawlDepth: "linked" },
          { type: "url", label: "https://docs.moss.dev/docs/integrate/authentication", crawlDepth: "single" },
          { type: "url", label: "https://docs.moss.dev/docs/integrate/retrieval", crawlDepth: "single" },
        ],
        packages: [
          {
            manager: "npm",
            name: "@moss-dev/moss",
            version: "1.1.0",
            importCheck:
              "node --input-type=module -e \"const m = await import('@moss-dev/moss'); if (!m.MossClient || !m.SessionIndex) process.exit(1)\"",
          },
        ],
        requiredEnv: [
          { name: "MOSS_PROJECT_ID", scopes: ["agent", "assertion", "cleanup"], required: true },
          { name: "MOSS_PROJECT_KEY", scopes: ["agent", "assertion", "cleanup"], required: true },
        ],
        setupSteps: [],
        preflightChecks: [],
        cleanupSteps: [{ name: "Run cleanup script if generated", command: "test ! -f kiln-cleanup.sh || bash kiln-cleanup.sh" }],
      },
      task:
        "Use the Moss JS SDK to create a temporary retrieval index, add the provided facts, query for the target answer, write the observed answer to src/moss-result.txt, and create kiln-cleanup.sh for deleting any temporary cloud resources.",
      assertions: [
        { type: "file", name: "Moss result file contains answer", config: { path: "src/moss-result.txt", contains: "kiln-known-answer" } },
        { type: "shell", name: "Cleanup script exists", config: { command: "test -f kiln-cleanup.sh" } },
        { type: "llm", name: "Uses Moss SDK APIs", config: { criterion: "The implementation uses the Moss SDK rather than hand-rolled retrieval logic." } },
      ],
    };
  }
  return {
    product: DEFAULT_PRODUCT,
    task: "Build a small integration using the product SDK. Initialize the official client, call one realistic workflow, and write the result to src/integration.ts with a repeatable test.",
    assertions: DEFAULT_ASSERTIONS,
  };
}

function NewEvalForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [step, setStep] = useState(1);
  const sdkTemplate = useMemo(() => templateFor("sdk"), []);
  const [product, setProduct] = useState<ProductProfile>(sdkTemplate.product);
  const [task, setTask] = useState(sdkTemplate.task);
  const [extraContexts, setExtraContexts] = useState<ContextSource[]>([]);
  const [assertions, setAssertions] = useState<Assertion[]>(sdkTemplate.assertions);
  const [agentType, setAgentType] = useState<AgentType>("claude-code");
  const [timeoutSec, setTimeoutSec] = useState(300);
  const [requestedRuns, setRequestedRuns] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const source = searchParams.get("from");
    if (!source) return;
    let cancelled = false;
    void fetch(`/api/evals/${encodeURIComponent(source)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (data: {
          eval?: {
            config: {
              task: string;
              language: Language;
              productProfile?: ProductProfile;
              context: ContextSource[];
              assertions: Assertion[];
              metadata: { agentType: AgentType; timeoutSec: number; requestedRuns?: number };
            };
          };
        } | null) => {
          if (cancelled || !data?.eval) return;
          setTask(data.eval.config.task);
          setProduct(
            data.eval.config.productProfile ?? {
              ...DEFAULT_PRODUCT,
              runtime: { ...DEFAULT_PRODUCT.runtime, language: data.eval.config.language },
            },
          );
          setExtraContexts(data.eval.config.context);
          setAssertions(data.eval.config.assertions);
          setAgentType(data.eval.config.metadata.agentType);
          setTimeoutSec(data.eval.config.metadata.timeoutSec);
          setRequestedRuns(data.eval.config.metadata.requestedRuns ?? 1);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  const profileContexts = product.docsSources;
  const allContexts = [...profileContexts, ...extraContexts];
  const tokenEstimate = useMemo(() => {
    const base = allContexts.length * 4000;
    const extra = allContexts.reduce((n, c) => n + (c.content?.length ?? 0), 0) / 4;
    return Math.round((base + extra) / 100) * 100;
  }, [allContexts]);

  const setupSteps = finalSetupSteps(product);
  const preflightChecks = finalPreflightChecks(product);
  const cleanupSteps = product.cleanupSteps ?? [];

  function updateProduct(patch: Partial<ProductProfile>) {
    setProduct((current) => ({ ...current, ...patch }));
  }

  function updateRuntime(patch: Partial<ProductProfile["runtime"]>) {
    setProduct((current) => ({ ...current, runtime: { ...current.runtime, ...patch } }));
  }

  function applyTemplate(kind: "sdk" | "api" | "cli" | "rag") {
    const next = templateFor(kind);
    setProduct(next.product);
    setTask(next.task);
    setAssertions(next.assertions);
    setExtraContexts([]);
  }

  function updateProductContext(idx: number, patch: Partial<ContextSource>) {
    setProduct((current) => ({
      ...current,
      docsSources: current.docsSources.map((source, i) => (i === idx ? { ...source, ...patch } : source)),
    }));
  }

  function addProductContext(type: ContextSourceType) {
    const labels: Record<ContextSourceType, string> = {
      url: "https://docs.example.com",
      repo: "github.com/org/repo",
      file: "uploaded-file.ts",
      paste: "Pasted snippet",
    };
    setProduct((current) => ({ ...current, docsSources: [...current.docsSources, { type, label: labels[type] }] }));
  }

  function removeProductContext(idx: number) {
    setProduct((current) => ({ ...current, docsSources: current.docsSources.filter((_, i) => i !== idx) }));
  }

  function addExtraContext(type: ContextSourceType) {
    const labels: Record<ContextSourceType, string> = {
      url: "https://docs.example.com/example",
      repo: "github.com/org/example",
      file: "fixture.ts",
      paste: "Scenario fixture",
    };
    setExtraContexts((current) => [...current, { type, label: labels[type] }]);
  }

  function updateExtraContext(idx: number, patch: Partial<ContextSource>) {
    setExtraContexts((current) => current.map((source, i) => (i === idx ? { ...source, ...patch } : source)));
  }

  function addSecret() {
    setProduct((current) => ({
      ...current,
      requiredEnv: [
        ...(current.requiredEnv ?? []),
        { name: "PRODUCT_API_KEY", scopes: ["agent", "assertion", "cleanup"], required: true },
      ],
    }));
  }

  function updateSecret(idx: number, patch: Partial<ProductEnvRequirement>) {
    setProduct((current) => ({
      ...current,
      requiredEnv: (current.requiredEnv ?? []).map((secret, i) => (i === idx ? { ...secret, ...patch } : secret)),
    }));
  }

  function toggleSecretScope(idx: number, scope: ProductEnvScope) {
    setProduct((current) => ({
      ...current,
      requiredEnv: (current.requiredEnv ?? []).map((secret, i) => {
        if (i !== idx) return secret;
        const scopes = new Set(secret.scopes);
        if (scopes.has(scope)) scopes.delete(scope);
        else scopes.add(scope);
        return { ...secret, scopes: [...scopes] };
      }),
    }));
  }

  function addPackage() {
    setProduct((current) => ({
      ...current,
      packages: [...(current.packages ?? []), { manager: "npm", name: "package-name", version: "latest" }],
    }));
  }

  function updatePackage(idx: number, patch: Partial<ProductPackage>) {
    setProduct((current) => ({
      ...current,
      packages: (current.packages ?? []).map((pkg, i) => (i === idx ? { ...pkg, ...patch } : pkg)),
    }));
  }

  function updateStep(
    key: "setupSteps" | "preflightChecks" | "cleanupSteps",
    idx: number,
    patch: Partial<ProductCommandStep>,
  ) {
    setProduct((current) => ({
      ...current,
      [key]: (current[key] ?? []).map((item, i) => (i === idx ? { ...item, ...patch } : item)),
    }));
  }

  function addStep(key: "setupSteps" | "preflightChecks" | "cleanupSteps", name: string) {
    setProduct((current) => ({
      ...current,
      [key]: [...(current[key] ?? []), { name, command: "echo replace-me" }],
    }));
  }

  function addAssertion(t: (typeof ASSERT_TEMPLATES)[number]) {
    setAssertions((current) => [...current, { type: t.type, name: t.name, config: t.config }]);
  }

  function updateAssertionName(idx: number, name: string) {
    setAssertions((current) => current.map((a, i) => (i === idx ? { ...a, name } : a)));
  }

  function updateAssertionConfig(idx: number, config: Assertion["config"]) {
    setAssertions((current) => current.map((a, i) => (i === idx ? { ...a, config } : a)));
  }

  function contextEditor(
    contexts: ContextSource[],
    update: (idx: number, patch: Partial<ContextSource>) => void,
    remove: (idx: number) => void,
  ) {
    return (
      <div className="context-sources">
        {contexts.map((c, i) => (
          <div className="context-source" key={`${c.type}-${i}`}>
            <span className={`ctx-badge ${ctxBadgeClass(c.type)}`}>{c.type}</span>
            <input
              className="inline-input"
              value={c.label}
              onChange={(e) => update(i, { label: e.target.value })}
              aria-label={`${c.type} source`}
            />
            {c.type === "url" && (
              <button
                className={`mini-toggle${c.crawlDepth === "linked" ? " selected" : ""}`}
                onClick={() => update(i, { crawlDepth: c.crawlDepth === "linked" ? "single" : "linked" })}
              >
                {c.crawlDepth === "linked" ? "linked pages" : "single page"}
              </button>
            )}
            <button className="ctx-remove" aria-label="Remove source" onClick={() => remove(i)}>
              x
            </button>
            {(c.type === "file" || c.type === "paste") && (
              <>
                {c.type === "file" && (
                  <input
                    className="file-input"
                    type="file"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      void file.text().then((content) => update(i, { label: file.name, content }));
                    }}
                  />
                )}
                <textarea
                  className="input compact"
                  value={c.content ?? ""}
                  onChange={(e) => update(i, { content: e.target.value })}
                  placeholder={c.type === "file" ? "Uploaded file contents" : "Paste docs or fixture text"}
                />
              </>
            )}
          </div>
        ))}
      </div>
    );
  }

  async function run() {
    setSubmitting(true);
    setSubmitError(null);
    const productProfile: ProductProfile = {
      ...product,
      runtime: { ...product.runtime, language: product.runtime.language },
      setupSteps: product.setupSteps ?? [],
      preflightChecks: product.preflightChecks ?? [],
      cleanupSteps,
    };
    try {
      const res = await fetch("/api/evals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task,
          language: product.runtime.language,
          productProfile,
          context: extraContexts,
          assertions,
          metadata: { agentType, timeoutSec, requestedRuns },
        }),
      });
      const data = (await res.json()) as { reportUrl?: string; error?: string };
      if (!res.ok || !data.reportUrl) {
        throw new Error(data.error ?? "Could not start eval.");
      }
      router.push(data.reportUrl);
      return;
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not start eval.");
    }
    setSubmitting(false);
  }

  return (
    <div className="form-wrapper">
      <div className="form-header">
        <h2>New Product Eval</h2>
        <p>Configure the product, docs, runtime, credentials, scenario, and deterministic checks.</p>
      </div>

      <div className="preset-row">
        <button className="tmpl-btn" onClick={() => applyTemplate("sdk")}>SDK preset</button>
        <button className="tmpl-btn" onClick={() => applyTemplate("api")}>API preset</button>
        <button className="tmpl-btn" onClick={() => applyTemplate("cli")}>CLI preset</button>
        <button className="tmpl-btn" onClick={() => applyTemplate("rag")}>Moss/RAG preset</button>
      </div>

      <div className="stepper">
        {STEP_LABELS.map((label, i) => {
          const n = i + 1;
          const state = n < step ? "done" : n === step ? "active" : "pending";
          return (
            <div key={label} style={{ display: "contents" }}>
              {i > 0 && <div className="step-line" />}
              <button
                className={`step ${state}`}
                style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}
                onClick={() => setStep(n)}
              >
                <span className="step-num">{state === "done" ? "✓" : n}</span>
                <span className="step-label">{label}</span>
              </button>
            </div>
          );
        })}
      </div>

      {step === 1 && (
        <div>
          <div className="product-grid">
            <div className="field">
              <label className="field-label">Company</label>
              <input className="input" value={product.companyName} onChange={(e) => updateProduct({ companyName: e.target.value })} />
            </div>
            <div className="field">
              <label className="field-label">Product</label>
              <input className="input" value={product.productName} onChange={(e) => updateProduct({ productName: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label className="field-label">Product type</label>
            <div className="lang-picker">
              {PRODUCT_TYPES.map((item) => (
                <button
                  key={item.value}
                  className={`lang-chip${product.productType === item.value ? " selected" : ""}`}
                  onClick={() => updateProduct({ productType: item.value })}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="product-grid">
            <div className="field">
              <label className="field-label">Language</label>
              <select
                className="input select-input"
                value={product.runtime.language}
                onChange={(e) => updateRuntime({ language: e.target.value as Language })}
              >
                {LANGUAGES.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label">Runtime image</label>
              <select
                className="input select-input"
                value={product.runtime.image ?? "default"}
                onChange={(e) => updateRuntime({ image: e.target.value as ProductRuntimeImage })}
              >
                {RUNTIME_IMAGES.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="field">
          <label className="field-label">Environment requirements</label>
          <div className="secret-list">
            {(product.requiredEnv ?? []).map((secret, i) => (
              <div className="secret-row" key={`${secret.name}-${i}`}>
                <input
                  className="inline-input mono"
                  value={secret.name}
                  onChange={(e) => updateSecret(i, { name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })}
                  aria-label="Environment variable name"
                />
                <label className="secret-required">
                  <input
                    type="checkbox"
                    checked={secret.required !== false}
                    onChange={(e) => updateSecret(i, { required: e.target.checked })}
                  />
                  required
                </label>
                <div className="scope-list">
                  {ENV_SCOPES.map((scope) => (
                    <button
                      key={scope}
                      className={`mini-toggle${secret.scopes.includes(scope) ? " selected" : ""}`}
                      onClick={() => toggleSecretScope(i, scope)}
                    >
                      {scope}
                    </button>
                  ))}
                </div>
                <button
                  className="ctx-remove"
                  aria-label="Remove environment variable"
                  onClick={() =>
                    setProduct((current) => ({
                      ...current,
                      requiredEnv: (current.requiredEnv ?? []).filter((_, idx) => idx !== i),
                    }))
                  }
                >
                  x
                </button>
              </div>
            ))}
          </div>
          <button className="ctx-add-btn" onClick={addSecret}>+ Secret requirement</button>
        </div>
      )}

      {step === 3 && (
        <div>
          <div className="field">
            <label className="field-label">Product docs</label>
            {contextEditor(product.docsSources, updateProductContext, removeProductContext)}
            <div className="context-add-btns">
              {CTX_ADD.map((b) => (
                <button key={b.type} className="ctx-add-btn" onClick={() => addProductContext(b.type)}>
                  + {b.label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="field-label">Scenario fixtures</label>
            {contextEditor(extraContexts, updateExtraContext, (idx) => setExtraContexts((current) => current.filter((_, i) => i !== idx)))}
            <div className="context-add-btns">
              {CTX_ADD.map((b) => (
                <button key={b.type} className="ctx-add-btn" onClick={() => addExtraContext(b.type)}>
                  + {b.label}
                </button>
              ))}
            </div>
          </div>
          <details className="context-preview context-bundle-preview">
            <summary>{allContexts.length} context source{allContexts.length === 1 ? "" : "s"} · ~{tokenEstimate.toLocaleString("en-US")} tokens</summary>
            <pre>{allContexts.map((source) => `### ${source.type}: ${source.label}\n${source.content ?? "Fetched fresh when the run starts."}`).join("\n\n")}</pre>
          </details>
        </div>
      )}

      {step === 4 && (
        <div>
          <div className="field">
            <label className="field-label">Task</label>
            <textarea className="input" value={task} onChange={(e) => setTask(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">Packages</label>
            <div className="package-list">
              {(product.packages ?? []).map((pkg, i) => (
                <div className="package-row" key={`${pkg.name}-${i}`}>
                  <select
                    className="inline-input small"
                    value={pkg.manager}
                    onChange={(e) => updatePackage(i, { manager: e.target.value as ProductPackage["manager"] })}
                  >
                    <option value="npm">npm</option>
                    <option value="pip">pip</option>
                    <option value="go">go</option>
                    <option value="shell">shell</option>
                  </select>
                  <input className="inline-input mono" value={pkg.name} onChange={(e) => updatePackage(i, { name: e.target.value })} />
                  <input
                    className="inline-input small"
                    value={pkg.version ?? ""}
                    onChange={(e) => updatePackage(i, { version: e.target.value || undefined })}
                    placeholder="version"
                  />
                  <button
                    className="ctx-remove"
                    aria-label="Remove package"
                    onClick={() => setProduct((current) => ({ ...current, packages: (current.packages ?? []).filter((_, idx) => idx !== i) }))}
                  >
                    x
                  </button>
                  <input
                    className="inline-input mono full"
                    value={pkg.installCommand ?? ""}
                    onChange={(e) => updatePackage(i, { installCommand: e.target.value || undefined })}
                    placeholder="Optional custom install command"
                  />
                  <input
                    className="inline-input mono full"
                    value={pkg.importCheck ?? ""}
                    onChange={(e) => updatePackage(i, { importCheck: e.target.value || undefined })}
                    placeholder="Optional import/preflight command"
                  />
                </div>
              ))}
            </div>
            <button className="ctx-add-btn" onClick={addPackage}>+ Package</button>
          </div>
          <div className="product-grid">
            <StepEditor title="Setup steps" steps={product.setupSteps ?? []} onAdd={() => addStep("setupSteps", "Setup")} onUpdate={(idx, patch) => updateStep("setupSteps", idx, patch)} onRemove={(idx) => setProduct((current) => ({ ...current, setupSteps: (current.setupSteps ?? []).filter((_, i) => i !== idx) }))} />
            <StepEditor title="Preflight checks" steps={product.preflightChecks ?? []} onAdd={() => addStep("preflightChecks", "Preflight")} onUpdate={(idx, patch) => updateStep("preflightChecks", idx, patch)} onRemove={(idx) => setProduct((current) => ({ ...current, preflightChecks: (current.preflightChecks ?? []).filter((_, i) => i !== idx) }))} />
          </div>
          <StepEditor title="Cleanup steps" steps={cleanupSteps} onAdd={() => addStep("cleanupSteps", "Cleanup")} onUpdate={(idx, patch) => updateStep("cleanupSteps", idx, patch)} onRemove={(idx) => setProduct((current) => ({ ...current, cleanupSteps: (current.cleanupSteps ?? []).filter((_, i) => i !== idx) }))} />
        </div>
      )}

      {step === 5 && (
        <div className="field">
          <label className="field-label">Pass/fail assertions</label>
          <div className="assertions">
            {assertions.map((a, i) => (
              <div className="assertion-row" key={`${a.type}-${i}`}>
                <span className={`assert-badge ${a.type}`}>{a.type.toUpperCase()}</span>
                <input className="inline-input" value={a.name} onChange={(e) => updateAssertionName(i, e.target.value)} />
                <button className="ctx-remove" aria-label="Remove assertion" onClick={() => setAssertions((current) => current.filter((_, idx) => idx !== i))}>x</button>
                {a.type === "http" && (
                  <div className="assert-config">
                    <input className="inline-input" value={(a.config as { url: string }).url} onChange={(e) => updateAssertionConfig(i, { ...(a.config as { url: string; expectStatus?: number }), url: e.target.value })} />
                    <input className="inline-input small" value={(a.config as { expectStatus?: number }).expectStatus ?? 200} onChange={(e) => updateAssertionConfig(i, { ...(a.config as { url: string; expectStatus?: number }), expectStatus: Number(e.target.value) })} />
                  </div>
                )}
                {a.type === "file" && (
                  <div className="assert-config">
                    <input className="inline-input" value={(a.config as { path: string }).path} onChange={(e) => updateAssertionConfig(i, { ...(a.config as { path: string; contains?: string }), path: e.target.value })} />
                    <input className="inline-input" value={(a.config as { contains?: string }).contains ?? ""} onChange={(e) => updateAssertionConfig(i, { ...(a.config as { path: string; contains?: string }), contains: e.target.value || undefined })} placeholder="Optional contains" />
                  </div>
                )}
                {a.type === "shell" && (
                  <div className="assert-config">
                    <input className="inline-input mono" value={(a.config as { command: string }).command} onChange={(e) => updateAssertionConfig(i, { ...(a.config as { command: string; cwd?: string }), command: e.target.value })} />
                  </div>
                )}
                {a.type === "llm" && (
                  <div className="assert-config">
                    <textarea className="input compact" value={(a.config as { criterion: string }).criterion} onChange={(e) => updateAssertionConfig(i, { criterion: e.target.value })} />
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="assertion-templates">
            {ASSERT_TEMPLATES.map((t) => (
              <button key={t.label} className="tmpl-btn" onClick={() => addAssertion(t)}>+ {t.label}</button>
            ))}
          </div>
        </div>
      )}

      {step === 6 && (
        <div>
          <div className="product-grid">
            <div className="field">
              <label className="field-label">Agent</label>
              <select className="input select-input" value={agentType} onChange={(e) => setAgentType(e.target.value as AgentType)}>
                {AGENTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="field-label">Timeout seconds</label>
              <input className="input" type="number" min={30} max={3600} value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))} />
            </div>
            <div className="field">
              <label className="field-label">Runs</label>
              <input className="input" type="number" min={1} max={10} value={requestedRuns} onChange={(e) => setRequestedRuns(Number(e.target.value))} />
            </div>
          </div>
          <div className="context-preview review-block">
            <p><strong>Product:</strong> {product.companyName} {product.productName} · {product.productType}</p>
            <p><strong>Runtime:</strong> {product.runtime.language} · {product.runtime.image ?? "default"}</p>
            <p><strong>Context:</strong> {allContexts.length} sources · ~{tokenEstimate.toLocaleString("en-US")} tokens</p>
            <p><strong>Setup:</strong> {setupSteps.length} setup · {preflightChecks.length} preflight · {cleanupSteps.length} cleanup</p>
            <p><strong>Secrets:</strong> {(product.requiredEnv ?? []).length} declared env requirement{(product.requiredEnv ?? []).length === 1 ? "" : "s"}</p>
            <p><strong>Assertions:</strong> {assertions.length}</p>
          </div>
        </div>
      )}

      <div className="form-nav">
        <button className="btn btn-ghost" disabled={step === 1} style={{ opacity: step === 1 ? 0.4 : 1 }} onClick={() => setStep((s) => Math.max(1, s - 1))}>
          Back{step > 1 ? `: ${STEP_LABELS[step - 2]}` : ""}
        </button>
        {step < STEP_LABELS.length ? (
          <button className="btn btn-primary" onClick={() => setStep((s) => Math.min(STEP_LABELS.length, s + 1))}>
            Next: {STEP_LABELS[step]}
          </button>
        ) : (
          <button className="btn btn-primary" disabled={submitting} onClick={run}>
            {submitting ? "Starting..." : "Run Eval"}
          </button>
        )}
      </div>
      {submitError && <p className="form-error">{submitError}</p>}
    </div>
  );
}

function StepEditor({
  title,
  steps,
  onAdd,
  onUpdate,
  onRemove,
}: {
  title: string;
  steps: ProductCommandStep[];
  onAdd: () => void;
  onUpdate: (idx: number, patch: Partial<ProductCommandStep>) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="field">
      <label className="field-label">{title}</label>
      <div className="step-list">
        {steps.map((item, idx) => (
          <div className="command-step" key={`${item.name}-${idx}`}>
            <input className="inline-input" value={item.name} onChange={(e) => onUpdate(idx, { name: e.target.value })} />
            <button className="ctx-remove" aria-label={`Remove ${title}`} onClick={() => onRemove(idx)}>x</button>
            <input className="inline-input mono full" value={item.command} onChange={(e) => onUpdate(idx, { command: e.target.value })} />
            <input className="inline-input mono full" value={item.cwd ?? ""} onChange={(e) => onUpdate(idx, { cwd: e.target.value || undefined })} placeholder="Optional cwd" />
          </div>
        ))}
      </div>
      <button className="ctx-add-btn" onClick={onAdd}>+ {title}</button>
    </div>
  );
}

export default function NewEvalPage() {
  return (
    <Suspense fallback={<div className="form-wrapper">Loading eval form...</div>}>
      <NewEvalForm />
    </Suspense>
  );
}
