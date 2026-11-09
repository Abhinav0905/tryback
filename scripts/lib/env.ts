// Minimal .env loader for scripts run with tsx (Next.js loads .env.local itself; tsx doesn't).
//
//   import { loadProjectEnv } from "./lib/env";
//   const { files, loaded } = loadProjectEnv();   // before importing anything from lib/
//
// Precedence matches Next.js for scripts: variables already in the environment win, then
// .env.local, then .env. Values are never printed by this module.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Parse KEY=VALUE lines: `export ` prefix, quotes, `\n` in double quotes, trailing ` # comments`. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2] ?? "";
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out.set(key, value);
  }
  return out;
}

/**
 * Load one env file into `env` (default process.env) without overriding variables that are
 * already set. Returns the names it set (not the values). A missing file loads nothing.
 */
export function loadEnvFile(file: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const [key, value] of parseEnv(readFileSync(file, "utf8"))) {
    if (env[key] === undefined) {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

/** The env files scripts read, in precedence order. */
export const ENV_FILES = [".env.local", ".env"] as const;

/** Load .env.local then .env from `root`. Returns which files exist and which names were set. */
export function loadProjectEnv(
  root: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): { files: string[]; loaded: string[] } {
  const files: string[] = [];
  const loaded: string[] = [];
  for (const name of ENV_FILES) {
    const file = path.join(root, name);
    if (existsSync(file)) files.push(name);
    loaded.push(...loadEnvFile(file, env));
  }
  return { files, loaded };
}
