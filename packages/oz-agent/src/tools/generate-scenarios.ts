import type { Assertion, OzClaimConflict, OzProductProfile, OzResearchReport, OzScenario, ProductEnvRequirement } from "@kiln/shared";
import { evidence, type OzTool } from "./contracts.js";

interface GenerateScenariosInput {
  profile: OzProductProfile;
  research?: OzResearchReport;
  userGoal?: string;
}

function baseAssertions(): Assertion[] {
  return [
    { type: "file", name: "Integration entrypoint exists", config: { path: "src/index.mjs" } },
    { type: "shell", name: "Project command succeeds", config: { command: "node src/index.mjs" } },
    {
      type: "shell",
      name: "Result contract reports success",
      config: { command: "test -s src/oz-result.json && node -e \"const r=JSON.parse(require('node:fs').readFileSync('src/oz-result.json','utf8')); if(!r || typeof r !== 'object' || Array.isArray(r)) process.exit(1); if(r.ok !== true) process.exit(2); if(!r.operation && !r.usedEndpoint && !r.usedSdkPackage) process.exit(3);\"" },
    },
  ];
}

function nodeEntrypointTask(task: string): string {
  return [
    "Create `src/index.mjs` as the runnable Node entrypoint for this scenario.",
    "The entrypoint must run with `node src/index.mjs` from the project root.",
    "Write `src/oz-result.json` as the agent's result claim. Set `ok: true` only after a real successful product call or a documented local validation path; include `operation` plus `usedEndpoint` or `usedSdkPackage`, and include `httpStatus` when an HTTP response was observed. Kiln will independently verify this claim when a success oracle is configured.",
    "Never print, echo, log, serialize, or write secret environment variable values; validate credential presence by checking whether variables are set, and mention only variable names in errors or summaries.",
    task,
  ].join(" ");
}

function scenario(
  id: string,
  title: string,
  rationale: string,
  task: string,
  requiredEnv: ProductEnvRequirement[],
  sources = requiredEnv.length ? requiredEnv[0]?.description ?? rationale : rationale,
): OzScenario {
  return {
    id,
    title,
    rationale,
    task,
    assertions: baseAssertions(),
    dynamicProbes: [],
    requiredEnv,
    setupSteps: [],
    cleanupSteps: [],
    confidence: 0.78,
    sources: [evidence("generated-suite", sources, 0.78)],
    risks: [],
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeScenarioId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 54);
}

function claimValues(conflict: OzClaimConflict, kind: string): string[] {
  return [...new Set(conflict.claims.filter((claim) => claim.kind === kind).map((claim) => claim.value))];
}

function primarySubject(conflict: OzClaimConflict): string | undefined {
  return conflict.claims.find((claim) => claim.subject && claim.subject !== "product" && claim.subject !== "node" && claim.subject !== "python")?.subject;
}

function nodeExportAssertion(pkgName: string, symbols: string[]): Assertion | null {
  if (symbols.length === 0) return null;
  const script = [
    "pkg=$1",
    "shift",
    "node --input-type=module - \"$pkg\" \"$@\" <<'NODE'",
    "const [pkg, ...symbols] = process.argv.slice(2);",
    "const mod = await import(pkg);",
    "const missing = symbols.filter((name) => !(name in mod));",
    "if (missing.length) { console.error(`Missing SDK exports: ${missing.join(', ')}`); process.exit(1); }",
    "NODE",
  ].join("\n");
  return {
    type: "shell",
    name: `Published SDK exports documented symbols: ${symbols.slice(0, 3).join(", ")}`,
    config: { command: ["sh -c", shellSingleQuote(script), "--", shellSingleQuote(pkgName), ...symbols.map(shellSingleQuote)].join(" ") },
    severityOnFail: "high",
    frictionCode: "sdk_export_mismatch",
    canHardCap: true,
    hardCapGrade: "C-",
    codeVsNoCode: "code",
  };
}

function nodeTypesMethodAssertion(pkgName: string, methods: string[]): Assertion | null {
  if (methods.length === 0) return null;
  const script = [
    "pkg=$1",
    "shift",
    "root=\"node_modules/$pkg\"",
    "[ -d \"$root\" ] || { echo \"Package not installed: $pkg\" >&2; exit 1; }",
    "for method in \"$@\"; do",
    "  if ! find \"$root\" -type f \\( -name '*.d.ts' -o -name '*.ts' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \\) -maxdepth 8 -print0 | xargs -0 grep -F -- \"$method\" >/dev/null 2>&1; then",
    "    echo \"Documented SDK method not found in installed package: $method\" >&2; exit 1;",
    "  fi",
    "done",
  ].join("; ");
  return {
    type: "shell",
    name: `Installed SDK contains documented methods: ${methods.slice(0, 3).join(", ")}`,
    config: { command: ["sh -c", shellSingleQuote(script), "--", shellSingleQuote(pkgName), ...methods.map(shellSingleQuote)].join(" ") },
    severityOnFail: "medium",
    frictionCode: "sdk_method_mismatch",
    canHardCap: false,
    codeVsNoCode: "code",
  };
}

function pythonImportAssertion(modules: string[]): Assertion | null {
  if (modules.length === 0) return null;
  const script = [
    "python3 - \"$@\" <<'PY'",
    "import importlib, sys",
    "missing = []",
    "for name in sys.argv[1:]:",
    "    try:",
    "        importlib.import_module(name)",
    "    except Exception as exc:",
    "        missing.append(f'{name}: {exc}')",
    "if missing:",
    "    print('Missing documented Python imports: ' + '; '.join(missing), file=sys.stderr)",
    "    sys.exit(1)",
    "PY",
  ].join("\n");
  return {
    type: "shell",
    name: `Installed Python package exposes documented imports: ${modules.slice(0, 3).join(", ")}`,
    config: { command: ["sh -c", shellSingleQuote(script), "--", ...modules.map(shellSingleQuote)].join(" ") },
    severityOnFail: "medium",
    frictionCode: "python_import_mismatch",
    canHardCap: false,
    codeVsNoCode: "code",
  };
}

function scenarioFromConflict(profile: OzProductProfile, conflict: OzClaimConflict, requiredEnv: ProductEnvRequirement[]): OzScenario | null {
  const subject = primarySubject(conflict);
  const source = conflict.claims[0]?.evidence ?? profile.evidence[0] ?? evidence("research", conflict.title, conflict.confidence);
  if (conflict.id.startsWith("sdk-symbols-missing") || conflict.id.startsWith("sdk-methods-missing")) {
    const pkgName = subject ?? profile.sdks.find((sdk) => sdk.manager === "npm")?.packageName;
    if (!pkgName) return null;
    const symbols = claimValues(conflict, "sdk.doc_symbol").slice(0, 6);
    const methods = claimValues(conflict, "sdk.doc_method").slice(0, 8);
    const assertions = [
      ...baseAssertions(),
      nodeExportAssertion(pkgName, symbols),
      nodeTypesMethodAssertion(pkgName, methods),
    ].filter((item): item is Assertion => Boolean(item));
    return {
      id: `${conflict.id.startsWith("sdk-methods") ? "sdk_method" : "sdk_symbol"}_claim_consistency_${safeScenarioId(pkgName)}`,
      title: conflict.id.startsWith("sdk-methods") ? "SDK method claim consistency" : "SDK symbol claim consistency",
      rationale: "Research found a mismatch between documented SDK symbols or methods and the published package surface.",
      task: nodeEntrypointTask(`Install and import ${pkgName}. Verify the documented SDK symbols and methods against the installed package before building a minimal integration. If a documented symbol or method is absent, report that exact mismatch in src/oz-result.json instead of inventing an adapter or replacement API.`),
      assertions,
      dynamicProbes: [],
      requiredEnv,
      setupSteps: [],
      cleanupSteps: [],
      confidence: conflict.confidence,
      sources: [source],
      risks: [{
        code: conflict.id,
        severity: conflict.severity,
        message: conflict.title,
        evidence: conflict.claims.map((claim) => claim.evidence).slice(0, 3),
      }],
    };
  }
  if (conflict.id.startsWith("python-import-module-mismatch")) {
    const pkgName = subject ?? profile.sdks.find((sdk) => sdk.manager === "pip")?.packageName;
    if (!pkgName) return null;
    const modules = claimValues(conflict, "sdk.doc_py_module").slice(0, 6);
    const importAssertion = pythonImportAssertion(modules);
    return {
      id: `python_sdk_import_claim_consistency_${safeScenarioId(pkgName)}`,
      title: "Python SDK import claim consistency",
      rationale: "Research found a mismatch between documented Python imports and package metadata examples.",
      task: [
        "Create `src/index.py` as a Python entrypoint for this scenario.",
        `Install and import the documented ${pkgName} Python package modules.`,
        "Write `src/oz-result.json` with the import result and exact missing module or symbol names if package behavior differs from docs.",
      ].join(" "),
      assertions: [
        { type: "file", name: "Python integration entrypoint exists", config: { path: "src/index.py" } },
        { type: "shell", name: "Python entrypoint succeeds", config: { command: "python3 src/index.py" } },
        ...(importAssertion ? [importAssertion] : []),
      ],
      dynamicProbes: [],
      requiredEnv,
      setupSteps: [],
      cleanupSteps: [],
      confidence: conflict.confidence,
      sources: [source],
      risks: [{
        code: conflict.id,
        severity: conflict.severity,
        message: conflict.title,
        evidence: conflict.claims.map((claim) => claim.evidence).slice(0, 3),
      }],
    };
  }
  if (conflict.id === "auth-shape-ambiguity") {
    return scenario(
      "auth_claim_mapping_consistency",
      "Auth claim mapping consistency",
      "Research found multiple credential shapes across docs, headers, body fields, or environment variables.",
      nodeEntrypointTask(`Build the smallest ${profile.productName} auth initialization path and write a clear mapping from dashboard credential names to SDK env vars, REST headers, and REST body fields. Do not guess missing names; preserve ambiguity explicitly in src/oz-result.json.`),
      requiredEnv,
      conflict.recommendation,
    );
  }
  if (conflict.id === "query-load-semantics-ambiguous") {
    return scenario(
      "sdk_query_load_semantics",
      "SDK query/load semantics",
      "Research found contradictory claims about whether query() requires loadIndex() or can fall back to cloud behavior.",
      nodeEntrypointTask(`Using the documented SDK for ${profile.productName}, verify the expected query/loadIndex sequence. If docs conflict, implement the most conservative sequence and record which source claim was followed in src/oz-result.json.`),
      requiredEnv,
      conflict.recommendation,
    );
  }
  if (conflict.id === "runtime-node-version-mismatch" || conflict.id === "runtime-python-version-mismatch") {
    return scenario(
      `runtime_claim_consistency_${conflict.id.includes("python") ? "python" : "node"}`,
      "Runtime requirement consistency",
      "Research found conflicting runtime requirements across docs, repository metadata, or package metadata.",
      nodeEntrypointTask(`Before integrating ${profile.productName}, verify the runtime requirement claims from the docs and package metadata. Use the strictest documented runtime and record the chosen version constraint in src/oz-result.json.`),
      requiredEnv,
      conflict.recommendation,
    );
  }
  return null;
}

function researchScenarios(profile: OzProductProfile, research: OzResearchReport | undefined, requiredEnv: ProductEnvRequirement[]): OzScenario[] {
  if (!research) return [];
  return research.conflicts
    .map((conflict) => scenarioFromConflict(profile, conflict, requiredEnv))
    .filter((item): item is OzScenario => Boolean(item))
    .slice(0, 6);
}

export const generateScenariosTool: OzTool<GenerateScenariosInput, { scenarios: OzScenario[] }> = {
  name: "generate_scenarios",
  description: "Generate 3 to 10 realistic integration scenarios with rationale and evidence.",
  inputSchema: { type: "object", required: ["profile"] },
  outputSchema: { type: "object" },
  async execute(input) {
    const profile = input.profile;
    const env = profile.requiredEnv;
    const product = profile.productName;
    const hasSdk = profile.sdks.length > 0;
    const hasApi = profile.APIs.length > 0 || profile.productType.includes("api") || profile.auth !== undefined;
    const firstCallTask = hasApi
      ? `Build a minimal Node integration for ${product} using the documented HTTP API or curl examples. If SDK docs are also present, leave SDK import testing to the separate SDK scenario. Initialize request headers from environment variables and make the simplest safe successful call or local dry-run.`
      : hasSdk
        ? `Build a minimal Node integration for ${product}. Use the documented SDK ${profile.sdks[0]?.packageName}, initialize the client with documented environment variables, make the simplest safe successful call or local dry-run, and write the observed result to src/oz-result.json.`
        : `Build a minimal Node integration for ${product} using the documented HTTP API or curl examples. Do not search package registries unless the docs name an SDK. Initialize request headers from environment variables and make the simplest safe successful call or local dry-run.`;
    const scenarios: OzScenario[] = [
      scenario(
        "first_successful_call",
        "First successful call",
        "Every integration starts with installing the SDK or calling the API successfully.",
        nodeEntrypointTask(firstCallTask),
        env,
        profile.evidence[0]?.quote ?? "Product docs were discovered.",
      ),
    ];
    if (hasSdk) {
      scenarios.push(scenario(
        "sdk_import_init",
        "SDK import and client initialization",
        "Agents often fail before business logic when install/import/auth docs are unclear.",
        nodeEntrypointTask(`Import the documented ${product} SDK or client, initialize it with environment variables, and export a small reusable client factory. Use only SDK packages found in the provided product profile.`),
        env,
      ));
    } else if (hasApi) {
      scenarios.push(scenario(
        "http_client_init",
        "HTTP client initialization",
        "REST-only products should be tested through documented endpoints and headers instead of invented SDKs.",
        nodeEntrypointTask(`Export a small reusable ${product} HTTP client. Use the documented base URL, version headers, and auth headers from the provided docs. Do not import an SDK unless one is listed in the product profile.`),
        env,
      ));
    }
    if (env.length > 0) {
      scenarios.push(
        scenario(
          "auth_failure_handling",
          "Auth failure handling",
          "A good integration should make missing or invalid credentials obvious without leaking secrets.",
          nodeEntrypointTask(`Add credential validation for ${product}. When required env vars are missing, fail with a clear message that names the variable but never prints the secret value. When env vars are present, run the smallest safe documented call or validation path.`),
          env,
        ),
      );
    }
    if (profile.webhooks.length > 0 || profile.productType.includes("payments")) {
      scenarios.push(
        scenario(
          "webhook_signature_verification",
          "Webhook signature verification",
          "Webhook-heavy products need deterministic signature verification checks to prevent false-success integrations.",
          nodeEntrypointTask(`Implement a ${product} webhook handler that verifies the documented signature before accepting events. Include a forged-signature negative path.`),
          env,
        ),
      );
    }
    if (profile.productType.includes("payments") || profile.APIs.some((api) => /idempot/i.test(api.name))) {
      scenarios.push(
        scenario(
          "idempotent_creation",
          "Idempotent creation",
          "Payment-like create operations should avoid duplicate resources on retries.",
          nodeEntrypointTask(`Implement a create workflow for ${product} using an idempotency key if the docs support it, and document how retries are handled.`),
          env,
        ),
      );
    }
    if (profile.productType.includes("rag") || profile.productType.includes("ai-sdk")) {
      scenarios.push(
        scenario(
          "retrieval_or_model_workflow",
          "Retrieval/model workflow",
          "AI and RAG products need tests that prove the agent used the SDK instead of hand-rolled placeholders.",
          nodeEntrypointTask(`Use ${product} to build the smallest documented retrieval or model workflow. Include cleanup for any created resources.`),
          env,
        ),
      );
    }
    const unique = new Map<string, OzScenario>();
    for (const item of [...scenarios, ...researchScenarios(profile, input.research, env)]) unique.set(item.id, item);
    return { scenarios: [...unique.values()].slice(0, 10) };
  },
};
