#!/usr/bin/env node
/**
 * Fails when a code excerpt in docs/ no longer matches the source it quotes.
 *
 * Every <pre> in a doc must declare what it is:
 *
 *   <pre data-src="src/lib/cli/claude.ts">   — a verbatim quote. Its text must appear, character
 *                                              for character and as one contiguous run, in that
 *                                              file.
 *   <pre data-src="…" data-quote="lines">    — a stitched excerpt: real lines pulled from across
 *                                              one file with the uninteresting middle dropped.
 *                                              Every line must still exist verbatim in it; only
 *                                              contiguity is waived.
 *   <pre data-src="…" data-quote="text">     — a run of text that is not whole source lines: a
 *                                              prompt body quoted out of the middle of a template
 *                                              literal, say. Must appear as an exact substring of
 *                                              the file.
 *   <pre data-illustrative>                  — pseudo-code or a shape sketch. Not checked, and
 *                                              deliberately not passed off as real source.
 *
 * An undeclared <pre> is an error, not a pass. That is the point: a new snippet cannot be added
 * without someone deciding which of the two it is.
 *
 * Matching is on content, never on line numbers. A `path:42` anchor breaks on any unrelated edit
 * above line 42, and a check that fails for reasons the author cannot act on is a check that gets
 * bypassed. Content matching fails only when the quoted code actually changed.
 *
 * Indentation is normalised on both sides — a snippet is usually dedented out of the function it
 * came from, which is a presentation choice, not drift.
 *
 * Usage: node scripts/check-docs-sync.mjs [--json]
 * Exit:  0 all excerpts current · 1 drift or an undeclared <pre> · 2 could not run
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const DOCS_DIR = "docs";

/** HTML entities the docs actually use. Kept explicit — a general-purpose decoder would be a dependency. */
const ENTITIES = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&rarr;": "→",
  "&larr;": "←",
  "&hellip;": "…",
  "&asymp;": "≈",
  "&middot;": "·",
};

function decodeEntities(html) {
  // &amp; last: decoding it first would turn "&amp;lt;" into "<" instead of "&lt;".
  let out = html;
  for (const [entity, char] of Object.entries(ENTITIES)) out = out.split(entity).join(char);
  return out.split("&amp;").join("&");
}

/** Trailing whitespace, surrounding blank lines and common indent are presentation, not content. */
function normalise(text) {
  let lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const indents = lines.filter((line) => line !== "").map((line) => line.match(/^[ \t]*/)[0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => (line === "" ? "" : line.slice(common)));
}

/** True when `snippet` appears as a contiguous run of lines in `source`, ignoring indent depth. */
function findSnippet(snippetLines, sourceLines) {
  const needle = snippetLines.join("\n");
  for (let start = 0; start + snippetLines.length <= sourceLines.length; start++) {
    const window = normalise(sourceLines.slice(start, start + snippetLines.length).join("\n"));
    if (window.join("\n") === needle) return start + 1; // 1-indexed, for the report only
  }
  return null;
}

/** The first snippet line that appears nowhere in the file — the most useful thing to show. */
function firstMissingLine(snippetLines, sourceLines) {
  const haystack = sourceLines.map((line) => line.trim());
  for (const line of snippetLines) {
    if (line.trim() === "") continue;
    if (!haystack.includes(line.trim())) return line;
  }
  return snippetLines.find((line) => line.trim() !== "") ?? "";
}

async function collectHtmlDocs(dir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(join(REPO_ROOT, dir), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await collectHtmlDocs(path)));
    else if (entry.name.endsWith(".html")) found.push(path);
  }
  return found;
}

/** Pulls every <pre> with its attributes. Deliberately not a parser — docs here are hand-written HTML. */
function extractPreBlocks(html) {
  const blocks = [];
  const re = /<pre\b([^>]*)>\s*(?:<code\b[^>]*>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/g;
  let match;
  while ((match = re.exec(html))) {
    const [, attrs, body] = match;
    const src = attrs.match(/data-src\s*=\s*"([^"]+)"/);
    const quote = attrs.match(/data-quote\s*=\s*"([^"]+)"/);
    blocks.push({
      line: html.slice(0, match.index).split("\n").length,
      src: src ? src[1] : null,
      mode: quote ? quote[1] : "contiguous",
      illustrative: /\bdata-illustrative\b/.test(attrs),
      code: decodeEntities(body),
    });
  }
  return blocks;
}

async function main() {
  const asJson = process.argv.includes("--json");
  const docs = await collectHtmlDocs(DOCS_DIR);
  const problems = [];
  let checked = 0;
  let illustrative = 0;

  const sourceCache = new Map();
  const loadSource = async (path) => {
    if (!sourceCache.has(path)) {
      sourceCache.set(
        path,
        readFile(join(REPO_ROOT, path), "utf-8").then(
          (text) => text.split("\n"),
          () => null,
        ),
      );
    }
    return sourceCache.get(path);
  };

  for (const doc of docs) {
    const html = await readFile(join(REPO_ROOT, doc), "utf-8");
    for (const block of extractPreBlocks(html)) {
      if (block.illustrative) {
        illustrative++;
        continue;
      }
      if (!block.src) {
        problems.push({
          doc,
          line: block.line,
          kind: "undeclared",
          detail:
            'This <pre> declares neither data-src="<file>" nor data-illustrative, so nothing can tell whether it quotes real source.',
        });
        continue;
      }

      const sourceLines = await loadSource(block.src);
      if (!sourceLines) {
        problems.push({
          doc,
          line: block.line,
          kind: "missing-source",
          detail: `data-src points at ${block.src}, which could not be read. Update the anchor, or restore the file.`,
        });
        continue;
      }

      if (!["contiguous", "lines", "text"].includes(block.mode)) {
        problems.push({
          doc,
          line: block.line,
          kind: "bad-mode",
          detail: `data-quote="${block.mode}" is not a mode. Use "contiguous" (the default), "lines" or "text".`,
        });
        continue;
      }

      checked++;
      const snippet = normalise(block.code);
      if (snippet.length === 0) continue;

      let stray;
      if (block.mode === "text") {
        // Not line-structured: the snippet sits inside a longer construct, so only an exact
        // substring of the file proves it is still what the code says.
        stray = sourceLines.join("\n").includes(snippet.join("\n")) ? undefined : firstMissingLine(snippet, sourceLines);
      } else if (block.mode === "lines") {
        stray = snippet.find((line) => line.trim() !== "" && !sourceLines.some((s) => s.trim() === line.trim()));
      } else {
        stray = findSnippet(snippet, sourceLines) === null ? firstMissingLine(snippet, sourceLines) : undefined;
      }

      if (stray !== undefined) {
        const contiguousHint =
          block.mode === "contiguous" && !snippet.some((l) => l.trim() !== "" && !sourceLines.some((s) => s.trim() === l.trim()))
            ? '\n      Every line does exist in that file, just not consecutively — if that is intended, mark the block data-quote="lines".'
            : "";
        problems.push({
          doc,
          line: block.line,
          kind: "drift",
          detail: `No longer matches ${block.src}. First line not found there:\n      ${stray}${contiguousHint}`,
        });
      }
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ checked, illustrative, problems }, null, 2));
  } else if (problems.length === 0) {
    console.log(`docs in sync — ${checked} quoted excerpt(s) verified, ${illustrative} illustrative block(s) skipped`);
  } else {
    console.error(`docs out of sync — ${problems.length} problem(s):\n`);
    for (const problem of problems) {
      console.error(`  ${problem.doc}:${problem.line}  [${problem.kind}]`);
      console.error(`      ${problem.detail}\n`);
    }
    console.error("Quote the current source, or mark the block data-illustrative if it is a sketch.");
  }

  process.exitCode = problems.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`check-docs-sync failed to run: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
