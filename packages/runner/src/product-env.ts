import type { EvalConfig, ProductEnvScope } from "@kiln/shared";

export const BUILTIN_AGENT_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
];

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function declaredEnvNames(config: EvalConfig, scope: ProductEnvScope): string[] {
  const names = new Set<string>();
  for (const item of config.productProfile?.requiredEnv ?? []) {
    if (item.scopes.includes(scope)) names.add(item.name);
  }
  return [...names];
}

export function missingRequiredProductEnv(config: EvalConfig): string[] {
  const missing: string[] = [];
  for (const item of config.productProfile?.requiredEnv ?? []) {
    if (item.required === false) continue;
    if (!process.env[item.name]) missing.push(item.name);
  }
  return [...new Set(missing)].sort();
}

export function envAssignments(config: EvalConfig, scope: ProductEnvScope, extraNames: string[] = []): string[] {
  const names = new Set([...extraNames, ...declaredEnvNames(config, scope)]);
  return [...names].flatMap((name) => {
    const value = process.env[name];
    return value ? [`${name}=${shellQuote(value)}`] : [];
  });
}

export function envPrefix(config: EvalConfig, scope: ProductEnvScope, extraNames: string[] = []): string {
  const assignments = envAssignments(config, scope, extraNames);
  return assignments.length ? `env ${assignments.join(" ")} ` : "";
}

export function withScopedEnv(config: EvalConfig, scope: ProductEnvScope, command: string, extraNames: string[] = []): string {
  return `${envPrefix(config, scope, extraNames)}${command}`;
}

export function redactProductEnvValues(config: EvalConfig, text: string): string {
  let redacted = text;
  for (const item of config.productProfile?.requiredEnv ?? []) {
    const value = process.env[item.name];
    if (!value || value.length < 3) continue;
    redacted = redacted.split(value).join(`[redacted:${item.name}]`);
  }
  return redacted;
}
