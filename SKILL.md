---
name: dupscan
description: Use before writing new code (does this already exist?) and when reviewing for duplication or god-functions. Runs the dupscan CLI to find semantically similar code regions and size/nesting outliers, then judges what to do.
---

# dupscan — semantic duplication & anti-pattern review

`dupscan` reports **signal, not verdict**. It finds regions (functions, methods,
classes) that are semantically similar, and regions that are unusually large or
deeply nested. *You* decide whether a similarity is duplication worth removing
and whether an outlier is a genuine anti-pattern. Always read the code before
recommending a change — a high score is a lead, not a conclusion.

## Commands

- `dupscan scan <path> [--threshold 0.85] [--limit 50] [--show] [--json]`
  Near-duplicate clusters + size/nesting outliers. Exit code **1** when
  duplicates are found, **0** when clean — branch on it without parsing output.
- `dupscan similar <file:line | ->  [--limit 10] [--json]`
  Nearest-neighbor regions. Use `-` to pipe a snippet on stdin **before writing
  new code**, to check whether it already exists.
- `dupscan watch <path>`
  Keeps the on-disk index warm as files change, so later `scan`/`similar` calls
  are near-instant.

## When to use it

- **Before implementing** a helper/util, check for an existing one:
  `printf '%s' "$SNIPPET" | dupscan similar -`.
  If a region comes back above ~0.9, reuse it instead of duplicating.
- **During review**: `dupscan scan src`. For each cluster, open the members and
  judge: true duplication (extract a shared function) or coincidental structural
  similarity (leave it). Report the former with `file:line` references.
- **Outliers** are candidates, not verdicts. A 200-line function may be fine;
  judge cohesion before flagging it as a god-function.

## Reading output

`0.94  src/a.ts:12-40  <->  src/b.ts:80-108` means those two regions are 0.94
cosine-similar (higher = more alike). Clusters with 3+ members are stronger
duplication signals. `outlier  src/x.ts:5-180  (176 lines, nesting 6)  handle`
flags an unusually large or deeply nested region.

## Notes

- First run downloads a code-tuned embedding model (~160MB, cached once); the
  first full scan of a repo is slow, every scan after is incremental/instant.
  For a fast, small (~25MB) but less accurate run: `--model Xenova/all-MiniLM-L6-v2`.
- Languages: JavaScript/TypeScript and Python. Other files are ignored.
- The index lives in `.dupcache/` at the scanned path — add it to `.gitignore`.
- Similarity is per-language; it won't match a JS clone against a Python one.
