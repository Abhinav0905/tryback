/**
 * `next dev` / `next build` with a private NEXT_DIST_DIR (npm run record → .next-rec, npm run tune
 * → .next-tune) append `<distDir>/types/**` lines to tsconfig.json `include` and point
 * next-env.d.ts at that dir. Scripts that start such a server snapshot both files first and put
 * them back when the server stops (and, as a fallback, when the process exits), so running them
 * leaves the working tree as it was.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const NEXT_REWRITTEN_FILES = ["tsconfig.json", "next-env.d.ts"] as const;

/** Returns `restore()`: idempotent, returns the files it put back (relative to `root`). */
export function snapshotNextProjectFiles(root: string): () => string[] {
  const saved = NEXT_REWRITTEN_FILES.map((name) => {
    const file = path.join(root, name);
    return { name, file, text: existsSync(file) ? readFileSync(file, "utf8") : null };
  });
  const restore = (): string[] => {
    const restored: string[] = [];
    for (const s of saved) {
      try {
        const now = existsSync(s.file) ? readFileSync(s.file, "utf8") : null;
        if (now === s.text) continue;
        if (s.text === null) rmSync(s.file, { force: true });
        else writeFileSync(s.file, s.text);
        restored.push(s.name);
      } catch {
        /* best effort: never fail the script over a config file */
      }
    }
    return restored;
  };
  process.once("exit", () => void restore());
  return restore;
}
