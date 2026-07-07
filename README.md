# dupscan

A tiny CLI that finds **semantic** code duplication and anti-pattern signals by
embedding tree-sitter regions (functions/methods/classes) with a local model and
comparing them. It reports **signal, not verdict** — "these two regions are 0.94
similar", "this one is a 180-line outlier" — and leaves the judgment to you (or
your coding agent). One file, no build step, no server.

## Why embeddings, not syntax matching

Structural/token hashing is brittle: it misses code that does the same thing
written differently. Semantic embeddings catch near-duplicates across stylistic
variation. Tree-sitter's only job here is to chop code into meaningful regions;
the embeddings do the comparing.

## Install

```bash
npm install --save-dev dupscan
```

## Use

```bash
npx dupscan scan src                      # duplicate clusters + outliers
npx dupscan scan src --threshold 0.9 --show   # stricter, with snippets
npx dupscan similar src/util.ts:42        # what else looks like this region?
printf '%s' "$(pbpaste)" | npx dupscan similar -   # does this snippet exist yet?
npx dupscan watch src                     # keep the index warm in the background
```

`scan` exits **1** when it finds duplicates, **0** when clean.

First run downloads the embedding model (code-tuned `jina-embeddings-v2-base-code`,
~160MB q8, cached once). The first full scan of a repo is the slow part (all
regions embedded); every scan after that is incremental and near-instant.
Languages: JavaScript/TypeScript and Python.

**Want small & fast over accuracy?** `--model Xenova/all-MiniLM-L6-v2` drops to a
~25MB general-purpose model that scans ~4× faster but misses semantically-equal-
but-differently-written code (it's not code-tuned). The default is chosen for
accuracy — see the table below.

## How staleness works (the one clever bit)

Each region's identity is a hash of its normalized text, and embeddings are
cached by that hash — never by file:line. So a function that moves but doesn't
change costs nothing to re-scan; only genuinely new/changed regions are
re-embedded. Touching a file without editing it re-embeds nothing (the content
hash wins over mtime); renaming a file with identical content reuses every
vector; deleting a file garbage-collects its vectors. The cache lives in
`.dupcache/` at the scanned path — **gitignore it**.

## Config

| Option                | Default                    | Meaning                        |
|-----------------------|----------------------------|--------------------------------|
| `--model` / `DUPSCAN_MODEL` | `jinaai/jina-embeddings-v2-base-code` | embedding model id |
| `--dtype` / `DUPSCAN_DTYPE` | `q8`                 | quantization (`q8`/`fp16`/`fp32`) |
| `--threshold`         | `0.8`                      | cluster similarity cutoff      |
| `--limit`             | `50` (scan) / `10` (similar) | max results                  |
| `--show`              | off                        | include a snippet per cluster  |
| `--json`              | off                        | machine-readable output        |

Why the code model? On a loop-vs-`reduce` semantic-duplicate probe, the default
scored the pair 0.80 and an unrelated function 0.13 (separation 0.67);
all-MiniLM scored the same real duplicate just 0.61 — it would be *missed* at any
usable threshold. General text models (nomic, bge) were worse still, rating the
unrelated function as similar as the true duplicate.

## Limitations

O(n²) similarity (fine for small/medium repos); the default model is
general-purpose, not code-tuned; per-language only (no cross-language clones).

## Agents

Ships with `SKILL.md` — a companion skill that teaches coding agents when and how
to use the tool. Point your agent at it (or drop the commands into `CLAUDE.md`).

MIT licensed.
