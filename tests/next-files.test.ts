// scripts/lib/next-files.ts: tsconfig.json / next-env.d.ts are put back after a script's
// private-dist-dir Next server (npm run record / npm run tune) rewrote them.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotNextProjectFiles } from "@/scripts/lib/next-files";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "tryback-next-files-"));
  dirs.push(d);
  return d;
}

describe("snapshotNextProjectFiles", () => {
  it("restores rewritten files and removes ones that didn't exist", () => {
    const root = tmp();
    const tsconfig = '{ "include": ["next-env.d.ts", ".next/types/**/*.ts"] }\n';
    writeFileSync(path.join(root, "tsconfig.json"), tsconfig);
    const restore = snapshotNextProjectFiles(root);

    writeFileSync(path.join(root, "tsconfig.json"), '{ "include": [".next-rec/types/**/*.ts"] }\n');
    writeFileSync(path.join(root, "next-env.d.ts"), 'import "./.next-rec/types/routes.d.ts";\n');

    expect(restore().sort()).toEqual(["next-env.d.ts", "tsconfig.json"]);
    expect(readFileSync(path.join(root, "tsconfig.json"), "utf8")).toBe(tsconfig);
    expect(existsSync(path.join(root, "next-env.d.ts"))).toBe(false);
    // Idempotent: nothing left to restore.
    expect(restore()).toEqual([]);
  });

  it("leaves untouched files alone", () => {
    const root = tmp();
    writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
    writeFileSync(path.join(root, "next-env.d.ts"), "// env\n");
    const restore = snapshotNextProjectFiles(root);
    expect(restore()).toEqual([]);
    expect(readFileSync(path.join(root, "next-env.d.ts"), "utf8")).toBe("// env\n");
  });
});
