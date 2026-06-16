import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const envPath = new URL("../.env", import.meta.url);

function secret(prefix = "") {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function parse(lines) {
  const entries = [];
  const values = new Map();
  for (const line of lines) {
    const match = /^(\s*([A-Za-z_][A-Za-z0-9_]*)\s*=)(.*)$/.exec(line);
    if (!match) {
      entries.push({ line });
      continue;
    }
    const key = match[2];
    let value = match[3].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    entries.push({ key, prefix: match[1], value });
    values.set(key, value);
  }
  return { entries, values };
}

function isSet(value) {
  return typeof value === "string" && value.trim() && !["0", "changeme", "change_me", "replace_me"].includes(value.trim().toLowerCase());
}

const existingLines = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
const { entries, values } = parse(existingLines);

const generated = {
  KILN_FIRECRACKER_MANAGER_TOKEN: isSet(values.get("KILN_FIRECRACKER_MANAGER_TOKEN"))
    ? values.get("KILN_FIRECRACKER_MANAGER_TOKEN")
    : secret(),
  KILN_S3_ACCESS_KEY_ID: isSet(values.get("KILN_S3_ACCESS_KEY_ID"))
    ? values.get("KILN_S3_ACCESS_KEY_ID")
    : `kiln_${randomBytes(8).toString("hex")}`,
  KILN_S3_SECRET_ACCESS_KEY: isSet(values.get("KILN_S3_SECRET_ACCESS_KEY"))
    ? values.get("KILN_S3_SECRET_ACCESS_KEY")
    : secret(),
};

const managed = {
  DATABASE_URL: "postgres://kiln:kiln@127.0.0.1:55432/kiln",
  KILN_DB_AUTO_MIGRATE: "0",
  REDIS_URL: "redis://127.0.0.1:56379",
  KILN_QUEUE_MODE: "redis",
  RUNNER_ENABLE_QUEUE: "1",
  KILN_S3_BUCKET: "kiln",
  KILN_S3_REGION: "us-east-1",
  KILN_S3_ENDPOINT: "http://127.0.0.1:59000",
  KILN_S3_FORCE_PATH_STYLE: "1",
  KILN_S3_PREFIX: "kiln",
  KILN_SANDBOX_MODE: "firecracker",
  KILN_FIRECRACKER_MANAGER_URL: "http://127.0.0.1:8787",
  KILN_FIRECRACKER_MANAGER_HOST: "127.0.0.1",
  KILN_FIRECRACKER_MANAGER_PORT: "8787",
  KILN_FIRECRACKER_BIN: "/opt/kiln/firecracker/bin/firecracker",
  KILN_FIRECRACKER_KERNEL: "/opt/kiln/firecracker/vmlinux.bin",
  KILN_FIRECRACKER_ROOTFS: "/opt/kiln/firecracker/rootfs.ext4",
  KILN_FIRECRACKER_SSH_KEY: "/opt/kiln/firecracker/id_rsa",
  KILN_FIRECRACKER_WORK_DIR: "/var/lib/kiln/firecracker",
  KILN_FIRECRACKER_BOOT_TIMEOUT_MS: "30000",
  KILN_FIRECRACKER_MEMORY_MIB: "2048",
  KILN_FIRECRACKER_VCPU_COUNT: "2",
  KILN_AGENT_FALLBACK: "0",
  ...generated,
};

const seen = new Set();
const output = [];
for (const entry of entries) {
  if (!entry.key) {
    output.push(entry.line);
    continue;
  }
  if (seen.has(entry.key)) continue;
  seen.add(entry.key);
  if (Object.hasOwn(managed, entry.key)) output.push(`${entry.prefix}${managed[entry.key]}`);
  else output.push(`${entry.prefix}${entry.value}`);
}

for (const [key, value] of Object.entries(managed)) {
  if (!seen.has(key)) output.push(`${key}=${value}`);
}

writeFileSync(envPath, output.join("\n").replace(/\n*$/, "\n"));
console.log("Updated .env for the self-hosted Kiln stack. Existing provider/OAuth secrets were preserved.");
