import { loadDotEnv } from "./lib/env.mjs";

const fileEnv = loadDotEnv();
const env = { ...fileEnv, ...process.env };
const failures = [];
const warnings = [];

function value(name) {
  const raw = env[name];
  return typeof raw === "string" && raw.trim() ? raw.trim() : "";
}

function requireVar(name, reason) {
  if (!value(name)) failures.push(`${name} is required: ${reason}`);
}

function requireOne(names, reason) {
  if (!names.some((name) => value(name))) failures.push(`${names.join(" or ")} is required: ${reason}`);
}

function requireEquals(name, expected, reason) {
  const actual = value(name);
  if (actual !== expected) failures.push(`${name} must be "${expected}" for production (${actual || "unset"}): ${reason}`);
}

requireVar("DATABASE_URL", "Postgres stores users, eval configs, runs, sessions, verdicts, and grade reports.");
requireVar("REDIS_URL", "The web app enqueues runs and the worker consumes them through BullMQ.");
requireEquals("KILN_QUEUE_MODE", "redis", "production web requests must enqueue work instead of running agents in-process.");
requireEquals("RUNNER_ENABLE_QUEUE", "1", "the runner service must subscribe to the Redis queue.");
requireVar("KILN_S3_BUCKET", "Postgres-backed production runs store full traces in S3-compatible object storage.");
requireOne(["KILN_S3_REGION", "AWS_REGION"], "the S3 client needs a region unless your provider endpoint supplies one.");
if (value("KILN_S3_ENDPOINT")) {
  requireVar("KILN_S3_ACCESS_KEY_ID", "self-hosted S3-compatible storage needs an access key.");
  requireVar("KILN_S3_SECRET_ACCESS_KEY", "self-hosted S3-compatible storage needs a secret key.");
  requireEquals("KILN_S3_FORCE_PATH_STYLE", "1", "MinIO and most self-hosted S3-compatible endpoints require path-style access.");
}

requireVar("NEXT_PUBLIC_APP_URL", "OAuth redirects and share/report URLs must use the deployed origin.");
requireVar("GITHUB_CLIENT_ID", "GitHub OAuth sign-in is required in production.");
requireVar("GITHUB_CLIENT_SECRET", "GitHub OAuth sign-in is required in production.");

requireEquals("KILN_SANDBOX_MODE", "firecracker", "production runs should execute in isolated Firecracker sandboxes.");
requireVar("KILN_FIRECRACKER_MANAGER_URL", "the runner needs the Firecracker manager endpoint.");
requireVar("KILN_FIRECRACKER_MANAGER_TOKEN", "the runner should authenticate to the Firecracker manager.");
requireVar("KILN_FIRECRACKER_BIN", "the self-hosted Firecracker manager needs the firecracker binary path.");
requireVar("KILN_FIRECRACKER_KERNEL", "the self-hosted Firecracker manager needs an uncompressed guest kernel image.");
requireVar("KILN_FIRECRACKER_ROOTFS", "the self-hosted Firecracker manager needs an ext4 guest rootfs image.");
requireVar("KILN_FIRECRACKER_SSH_KEY", "the self-hosted Firecracker manager needs the private key authorized inside the guest rootfs.");

if (!value("ANTHROPIC_API_KEY") && value("CLAUDE_CODE_USE_BEDROCK") !== "1") {
  warnings.push("ANTHROPIC_API_KEY is unset and CLAUDE_CODE_USE_BEDROCK is not enabled; Claude Code runs may not be usable.");
}
if (value("ANTHROPIC_API_KEY") && !value("KILN_LLM_JUDGE_MODEL")) {
  warnings.push("KILN_LLM_JUDGE_MODEL is unset; LLM assertions will return advisory unconfigured failures.");
}
if (!value("KILN_CLAUDE_MODEL") && !value("ANTHROPIC_MODEL") && !value("ANTHROPIC_DEFAULT_SONNET_MODEL")) {
  warnings.push("No Claude model env is set; the runner will depend on SDK/provider defaults.");
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}

console.log("Production environment contract looks complete.");
