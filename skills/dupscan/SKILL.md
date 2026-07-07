---
name: dupscan
description: Use before writing new code (does this already exist?) and when reviewing for duplication or god-functions. Runs the dupscan CLI to find semantically similar code regions and size/nesting outliers, then judges what to do.
allowed-tools: Bash(npx dupscan:*)
---

# dupscan: semantic duplication and anti-pattern review

dupscan reports signal, not verdict. It finds regions (functions, methods, classes) that are semantically similar, and regions that are unusually large or deeply nested, and you decide whether a similarity is duplication worth removing and whether an outlier is a genuine anti-pattern. Always read the code before recommending a change, since a high score is a lead, not a conclusion.

The CLI ships on npm, so invoke it with `npx dupscan`, which fetches and caches it on first use.

## Commands

- `npx dupscan scan <path> --changed [--threshold 0.8] [--show] [--json]`
  Scan, but report only findings that touch your working diff (git modified, staged, or untracked). This is the main workflow, run it after writing or editing code.
- `npx dupscan scan <path> [--threshold 0.8] [--limit 50] [--show] [--json]`
  Whole-tree scan returning near-duplicate clusters and size/nesting outliers. Exit code 1 when duplicates are found, 0 when clean, so you can branch without parsing output.
- `npx dupscan similar <file:line | -> [--limit 10] [--json]`
  Nearest-neighbor regions for an existing region, or for a natural-language description piped on stdin ("retry with exponential backoff").
- `npx dupscan watch <path>`
  Keeps the on-disk index warm as files change, so later scans stay near-instant.

## When to use it

- After writing or editing code, run `npx dupscan scan <repo> --changed`, and for each reported cluster open the members and judge whether it is real duplication (extract a shared function) or coincidental similarity (leave it), reporting the former with file:line references.
- When reviewing a whole codebase, run `npx dupscan scan src` without `--changed`.
- Before writing something you can describe, query intent first with `printf '%s' "a debounce helper" | npx dupscan similar -`, and reuse a strong match instead of duplicating, though you should skip this when writing the code is faster than describing it.
- Treat outliers as candidates, not verdicts, since a 200-line function may be fine, so judge cohesion before flagging it as a god-function.

## Reading output

`0.94  src/a.ts:12-40  <->  src/b.ts:80-108` means those two regions are 0.94 cosine-similar, where higher is more alike, and clusters with three or more members are stronger duplication signals. A line like `outlier  src/x.ts:5-180  (176 lines, nesting 6)  handle` flags an unusually large or deeply nested region.

## Notes

- First run downloads a code-tuned embedding model (~160MB, cached once), so the first full scan of a repo is slow while every scan after it is incremental and fast. For a fast, small (~25MB) but less accurate run, pass `--model Xenova/all-MiniLM-L6-v2`.
- Languages are JavaScript, TypeScript, and Python, and other files are ignored.
- The index lives in `.dupcache/` at the scanned path, so add it to `.gitignore`.
- Similarity is per-language, so it will not match a JavaScript clone against a Python one.
