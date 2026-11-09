// Retention purge: delete shopper photos older than PHOTO_RETENTION_HOURS (default 24) and
// cached renders older than RENDER_RETENTION_DAYS (default 14), keeping pinned renders.
// The server already does this hourly (instrumentation.ts); use this to run it now, to preview
// it, or to pin a consenting team member's renders for judges' replay.
//
// Remote (a running server; needs its ADMIN_TOKEN):
//   npm run purge -- --base https://tryback-xyz.fly.dev [--dry-run]
//   npm run purge -- --base <url> --pin <returnId> [--note "team photo for judges"]
//   npm run purge -- --base <url> --unpin <returnId> | --unpin-all | --status
//
// Offline (the server must be STOPPED: it keeps the store in memory and would overwrite edits):
//   npm run purge -- --local [--data-dir .data] [--dry-run] [--pin <returnId>]

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const HELP = `TryBack retention purge

Remote (server running; ADMIN_TOKEN from --admin-token or the environment / .env.local):
  npm run purge -- --base <url> [--dry-run]           sweep now (or preview)
  npm run purge -- --base <url> --status              policy, last sweep, pins, files on disk
  npm run purge -- --base <url> --pin <returnId> [--note <text>]
  npm run purge -- --base <url> --unpin <returnId>
  npm run purge -- --base <url> --unpin-all

Offline (server stopped):
  npm run purge -- --local [--data-dir <dir>] [--dry-run] [--pin <returnId>] [--unpin <returnId>] [--unpin-all]
                   [--force]  (skip the "is a server running on :PORT?" check)

Retention: PHOTO_RETENTION_HOURS (default and max 24), RENDER_RETENTION_DAYS (default and max 14).
`;

/** Minimal KEY=VALUE loader (tsx doesn't read .env.local). Existing env vars win. */
function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m || raw.trim().startsWith("#")) continue;
    let value = m[2]!.trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.lastIndexOf(q) > 0) value = value.slice(1, value.lastIndexOf(q));
    else value = value.replace(/\s+#.*$/, "");
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
  }
}

async function remote(base: string, token: string, body: Record<string, unknown> | null): Promise<number> {
  const url = `${base.replace(/\/+$/, "")}/api/admin/retention`;
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  console.log(JSON.stringify(data, null, 2));
  if (!res.ok) {
    console.error(`\nHTTP ${res.status} from ${url}`);
    return 1;
  }
  return 0;
}

async function serverAnswers(port: string): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      local: { type: "boolean", default: false },
      "data-dir": { type: "string" },
      "admin-token": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      status: { type: "boolean", default: false },
      pin: { type: "string" },
      note: { type: "string" },
      unpin: { type: "string" },
      "unpin-all": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || (!values.base && !values.local)) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }
  loadEnvFile(path.join(process.cwd(), ".env.local"));
  loadEnvFile(path.join(process.cwd(), ".env"));

  const action: Record<string, unknown> = values.pin
    ? { action: "pin", returnId: values.pin, ...(values.note ? { note: values.note } : {}) }
    : values.unpin
      ? { action: "unpin", returnId: values.unpin }
      : values["unpin-all"]
        ? { action: "unpin_all" }
        : { action: "sweep", dryRun: values["dry-run"] };

  if (values.base) {
    const token = values["admin-token"] ?? process.env.ADMIN_TOKEN;
    if (!token) {
      console.error("Set ADMIN_TOKEN (the server's admin token) or pass --admin-token.");
      return 1;
    }
    return remote(values.base, token, values.status ? null : action);
  }

  // Offline: point the store at the data dir BEFORE loading it (DATA_DIR is read at import).
  if (values["data-dir"]) process.env.TRYBACK_DATA_DIR = values["data-dir"];
  process.env.TRYBACK_DATA_DIR ??= ".data";
  const port = process.env.PORT ?? "3000";
  if (!values.force && (await serverAnswers(port))) {
    console.error(
      `A TryBack server is answering on http://localhost:${port}. Stop it first (it keeps the store in memory and would\n` +
        `overwrite these changes), or run against it with --base http://localhost:${port}. --force skips this check.`,
    );
    return 1;
  }
  const retention = await import("../lib/retention");
  const { DATA_DIR } = await import("../lib/store");
  console.log(`data dir: ${DATA_DIR}`);
  if (values.status) {
    console.log(JSON.stringify(await retention.retentionStatus(), null, 2));
    return 0;
  }
  try {
    const result =
      action.action === "pin"
        ? await retention.pinReturnRenders(String(action.returnId), values.note)
        : action.action === "unpin"
          ? await retention.unpinRenders({ returnId: String(action.returnId) })
          : action.action === "unpin_all"
            ? await retention.unpinRenders({ all: true })
            : await retention.sweepRetention({ dryRun: values["dry-run"] });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
