# dupscan

A CLI that finds semantic code duplication and anti-pattern signals. It embeds
tree-sitter regions (functions, methods, classes) with a local model and
compares them, then reports similar regions and size or nesting outliers. It
reports signals, not verdicts, so you or a coding agent decide what to do with
them. It is a single file with no build step and no server.

## Why embeddings, not syntax matching

Token or AST hashing misses code that does the same thing written differently.
Embeddings catch near-duplicates across stylistic variation, and tree-sitter is
used only to split code into regions, while the embeddings do the comparing.

## Install

```bash
npm install --save-dev dupscan
```

## Use

```bash
npx dupscan scan . --changed              # after editing: only findings touching your diff
npx dupscan scan src                      # whole tree: duplicate clusters and outliers
npx dupscan scan src --threshold 0.9 --show   # stricter, with snippets
npx dupscan similar src/util.ts:42        # what else looks like this region?
printf '%s' "a debounce helper" | npx dupscan similar -   # query by intent before writing
npx dupscan watch src                     # keep the index warm in the background
```

`--changed` reindexes the whole tree, which is cheap once warm, but reports only
clusters and outliers involving files you have modified, staged, or added.
Outside a git repo it reports nothing.

`scan` exits 1 when it finds duplicates and 0 when clean.

The first run downloads the embedding model (`jina-embeddings-v2-base-code`,
about 160MB q8, cached once). The first full scan of a repo is the slow part
since every region is embedded, and every scan after that is incremental and
fast. Languages are JavaScript, TypeScript, and Python.

For a smaller and faster but less accurate run, pass
`--model Xenova/all-MiniLM-L6-v2`, a roughly 25MB general-purpose model that
scans about 4 times faster but misses code that is equivalent yet written
differently, since it is not code-tuned. The default is chosen for accuracy, as
the table below explains.

## How staleness works

Each region's identity is a hash of its normalized text, and embeddings are
cached by that hash rather than by file and line, so a function that moves but
does not change costs nothing to re-scan and only new or changed regions are
re-embedded. Touching a file without editing it re-embeds nothing, because the
content hash takes precedence over mtime; renaming a file with identical content
reuses every vector; and deleting a file drops its vectors. The cache lives in
`.dupcache/` at the scanned path, so add it to `.gitignore`.

## Config

| Option                | Default                    | Meaning                        |
|-----------------------|----------------------------|--------------------------------|
| `--model` / `DUPSCAN_MODEL` | `jinaai/jina-embeddings-v2-base-code` | embedding model id |
| `--dtype` / `DUPSCAN_DTYPE` | `q8`                 | quantization (`q8`/`fp16`/`fp32`) |
| `--threshold`         | `0.8`                      | cluster similarity cutoff      |
| `--limit`             | `50` (scan) / `10` (similar) | max results                  |
| `--show`              | off                        | include a snippet per cluster  |
| `--json`              | off                        | machine-readable output        |

On a loop-versus-`reduce` semantic-duplicate probe the default scored the pair
0.80 and an unrelated function 0.13, a separation of 0.67, while all-MiniLM
scored the same real duplicate 0.61, low enough to be missed at any usable
threshold. General text models such as nomic and bge did worse still, rating the
unrelated function as similar as the true duplicate.

## Limitations

Similarity is O(n²), which is fine for small and medium repos. The default code
model is about a 160MB download, so the first full scan is slow while every scan
after it is incremental. Similarity is cross-language, so equivalent logic in
JavaScript and Python scores about 0.95 and clones are caught across languages,
not only within one.

## Agents

The repo ships a companion skill at `skills/dupscan/` that tells coding agents
when to run the tool and how to read its output. Install it either way:

- Plugin: add this repo as a marketplace and install it, which brings in the
  skill and pre-approves `npx dupscan`:

  ```
  /plugin marketplace add Titou325/dupscan
  /plugin install dupscan@titou325
  ```
- Manual: copy `skills/dupscan/` into your project's `.claude/skills/` or your
  personal `~/.claude/skills/`.

The skill invokes `npx dupscan`, so the CLI is fetched from npm on first use and
there is nothing to vendor.

MIT licensed.
