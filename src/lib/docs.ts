import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface DocEntry {
  /** URL segment under /docs — also the only thing a request may name. */
  slug: string;
  title: string;
  blurb: string;
  /** Repo-relative path. Resolved against process.cwd() at read time, never stored absolute. */
  file: string;
}

/**
 * The console's Docs menu. A doc is reachable only if it is listed here: a request's slug is
 * looked up in this array and the *registered* path is what gets read, so no part of the incoming
 * URL ever reaches the filesystem. That is the whole path-traversal defence — don't replace it
 * with a join() over a user-supplied segment.
 */
export const DOCS: DocEntry[] = [
  {
    slug: "deck",
    title: "How the pipeline works",
    blurb:
      "A 20-slide walkthrough of the three stages and the headless CLI prompt logic behind them — stdin-fed prompts, the plan-mode write ban, and the fail-closed review verdict.",
    file: "docs/deck/index.html",
  },
];

export function findDoc(slug: string): DocEntry | undefined {
  return DOCS.find((doc) => doc.slug === slug);
}

/**
 * Reads a registered doc off disk on every request rather than at build time — these files are
 * edited in the working tree while the dev server runs, and a stale copy of the docs is worse
 * than a slow one.
 */
export async function readDoc(entry: DocEntry): Promise<string> {
  return readFile(join(process.cwd(), entry.file), "utf-8");
}
