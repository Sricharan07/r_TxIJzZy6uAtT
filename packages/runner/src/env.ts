import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function parseEnv(contents: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function findUp(filename: string, from = process.cwd()): string | null {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadDotEnv(path = process.env.KILN_ENV_FILE ?? findUp(".env")): void {
  if (!path || !existsSync(path)) return;
  const env = parseEnv(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(env)) {
    process.env[key] ??= value;
  }
}
