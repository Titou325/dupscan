#!/usr/bin/env node
// dupscan — find semantic code duplication and anti-pattern signals.
// Signal, not verdict: it reports "these regions are 0.94 similar" and
// "this region is a 180-line outlier". A human/agent decides what to do.
//
// Pipeline: discover files -> tree-sitter into regions (functions/methods/
// classes) -> embed each region with a local model (cached by content hash)
// -> cosine similarity -> clusters + size/nesting outliers.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, extname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

// Code-tuned by default: on a loop-vs-reduce semantic-duplicate probe it
// separated true dupes from coincidence ~2x better than all-MiniLM (which
// scored a real dup at 0.61, below any usable threshold). q8 quantization
// matches fp32 quality here at ~4x smaller download. Override via env/flags.
export const DEFAULT_MODEL = process.env.DUPSCAN_MODEL || 'jinaai/jina-embeddings-v2-base-code';
export const DEFAULT_DTYPE = process.env.DUPSCAN_DTYPE || 'q8';
export const DEFAULT_THRESHOLD = 0.8;
export const SCHEMA_VERSION = 1;
export const SUPPORTED = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py'];

// ---------------------------------------------------------------------------
// Region extraction (tree-sitter)
// ---------------------------------------------------------------------------

const GRAMMAR = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'tsx', '.py': 'python',
};

const KIND = {
  function_declaration: 'function',
  function_definition: 'function',
  method_definition: 'method',
  class_declaration: 'class',
  class_definition: 'class',
};

const NESTING = new Set([
  'statement_block', 'block', 'if_statement', 'for_statement', 'for_in_statement',
  'while_statement', 'try_statement', 'switch_statement', 'with_statement',
]);

let initPromise = null;
const langs = new Map();

async function loadLanguage(ext) {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
  const name = GRAMMAR[ext];
  if (!langs.has(name)) {
    const wasm = require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`);
    langs.set(name, await Language.load(wasm));
  }
  return langs.get(name);
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function nestingDepth(node) {
  let max = 0;
  const walk = (n, depth) => {
    const d = NESTING.has(n.type) ? depth + 1 : depth;
    if (d > max) max = d;
    for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i), d);
  };
  walk(node, 0);
  return max;
}

function nameOf(node) {
  const f = node.childForFieldName?.('name');
  return f ? f.text : null;
}

const FN_EXPR = new Set(['arrow_function', 'function_expression']);

// A function value bound to a name is a real region even though tree-sitter
// types it as an expression, not a declaration: `const foo = () => {}`,
// class field `foo = () => {}`, object property `{ foo: () => {} }`.
// Returns the name plus the function node to measure, or null.
function boundFunction(node) {
  if (node.type === 'variable_declarator' || node.type === 'assignment_expression') {
    const value = node.childForFieldName('value') ?? node.childForFieldName('right');
    const name = node.childForFieldName('name') ?? node.childForFieldName('left');
    if (value && FN_EXPR.has(value.type) && name?.type === 'identifier') {
      return { name: name.text, fn: value };
    }
  }
  if (node.type === 'public_field_definition' || node.type === 'field_definition') {
    const value = node.childForFieldName('value');
    const name = node.childForFieldName('name');
    if (value && FN_EXPR.has(value.type) && name) return { name: name.text, fn: value };
  }
  if (node.type === 'pair') {
    const value = node.childForFieldName('value');
    const key = node.childForFieldName('key');
    if (value && FN_EXPR.has(value.type) && key) {
      return { name: key.text.replace(/['"]/g, ''), fn: value };
    }
  }
  return null;
}

export async function extractFile(root, rel) {
  const ext = extname(rel);
  if (!GRAMMAR[ext]) return [];
  const source = await readFile(join(root, rel), 'utf8');
  const lang = await loadLanguage(ext);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);

  const regions = [];
  const visit = (node, insideClass) => {
    let kind = KIND[node.type];
    let name = kind ? nameOf(node) : null;
    let target = node;

    if (!kind) {
      const bound = boundFunction(node);
      if (bound) { kind = 'function'; name = bound.name; target = bound.fn; }
    }
    if (kind === 'function' && insideClass) kind = 'method'; // python method / class field

    if (kind && name) {
      const text = normalize(target.text);
      regions.push({
        file: rel,
        startLine: target.startPosition.row + 1,
        endLine: target.endPosition.row + 1,
        kind,
        name,
        text,
        hash: createHash('sha256').update(text).digest('hex'),
        lines: target.endPosition.row - target.startPosition.row + 1,
        nesting: nestingDepth(target),
      });
    }
    const nowInClass = insideClass || kind === 'class';
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i), nowInClass);
  };
  visit(tree.rootNode, false);
  return regions;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function gitFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
  } catch { return null; }
}

function walkDir(root, dir, acc) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === '.dupcache') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkDir(root, full, acc);
    else acc.push(relative(root, full));
  }
}

export async function discover(root) {
  let files = gitFiles(root);
  if (!files) { const acc = []; walkDir(root, root, acc); files = acc; }
  return files.filter((f) => SUPPORTED.includes(extname(f)));
}

// Files touched in the working tree (modified/staged/untracked), relative to
// root. Empty outside a git repo. Powers `scan --changed`.
export function changedFiles(root) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').filter(Boolean);
    } catch { return []; }
  };
  const all = [
    ...git(['diff', '--name-only', '--relative', 'HEAD']), // tracked, staged + unstaged
    ...git(['ls-files', '--others', '--exclude-standard']), // untracked
  ];
  return new Set(all.filter((f) => SUPPORTED.includes(extname(f))));
}

// ---------------------------------------------------------------------------
// Persistent index + staleness (the one advanced feature)
// Region identity = sha256 of normalized text. Vectors are cached by that hash,
// never by file:line, so a region that moves but doesn't change costs nothing.
// ---------------------------------------------------------------------------

async function loadIndex(indexPath, modelId) {
  try {
    const raw = JSON.parse(await readFile(indexPath, 'utf8'));
    if (raw.meta?.modelId === modelId && raw.meta?.schemaVersion === SCHEMA_VERSION) return raw;
  } catch { /* missing/unreadable/model-or-schema-change -> rebuild */ }
  return { meta: { modelId, schemaVersion: SCHEMA_VERSION }, files: {}, vectors: {} };
}

// embed: (texts: string[]) => Promise<number[][]>  — injected (fake in tests).
export async function reindex(root, { modelId, indexPath, embed }) {
  const prev = await loadIndex(indexPath, modelId);
  const files = await discover(root);
  const nextFiles = {};
  const stats = { embedded: 0, reused: 0, skippedFiles: 0, parsedFiles: 0 };

  for (const rel of files) {
    let st;
    try { st = await stat(join(root, rel)); }
    catch { continue; } // listed by git but absent on disk (deleted in worktree)
    const old = prev.files[rel];
    if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) {
      nextFiles[rel] = old;                 // fast path: no read, no parse
      stats.skippedFiles++;
      continue;
    }
    const source = await readFile(join(root, rel), 'utf8');
    const fileHash = createHash('sha256').update(source).digest('hex');
    if (old && old.fileHash === fileHash) {  // touched but identical content
      nextFiles[rel] = { ...old, mtimeMs: st.mtimeMs, size: st.size };
      continue;
    }
    const regions = await extractFile(root, rel);
    stats.parsedFiles++;
    nextFiles[rel] = { mtimeMs: st.mtimeMs, size: st.size, fileHash, regions };
  }

  const allRegions = Object.values(nextFiles).flatMap((f) => f.regions);

  const textByHash = new Map();
  for (const r of allRegions) if (!textByHash.has(r.hash)) textByHash.set(r.hash, r.text);
  const missing = [...textByHash.keys()].filter((h) => !(h in prev.vectors));

  const fresh = new Map();
  if (missing.length) {
    const vecs = await embed(missing.map((h) => textByHash.get(h)));
    missing.forEach((h, i) => fresh.set(h, vecs[i]));
    stats.embedded = missing.length;
  }

  // Rebuilding from current hashes only == garbage collection of stale vectors.
  const vectors = new Map();
  const vectorsObj = {};
  for (const h of textByHash.keys()) {
    const v = fresh.get(h) ?? prev.vectors[h];
    if (!v) continue;
    vectors.set(h, v);
    vectorsObj[h] = v;
    if (!fresh.has(h)) stats.reused++;
  }

  await mkdir(join(indexPath, '..'), { recursive: true });
  await writeFile(indexPath, JSON.stringify({
    meta: { modelId, schemaVersion: SCHEMA_VERSION }, files: nextFiles, vectors: vectorsObj,
  }));

  return { regions: allRegions, vectors, stats };
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Union-find: edge when two regions are >= threshold similar. Identical text
// (same hash) is always an edge, so exact clones cluster even with one vector.
export function findClusters(items, vectors, threshold) {
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { parent[find(i)] = find(j); };
  const sims = items.map(() => ({}));

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      let s;
      if (items[i].hash === items[j].hash) s = 1;
      else {
        const vi = vectors.get(items[i].hash), vj = vectors.get(items[j].hash);
        s = vi && vj ? cosine(vi, vj) : 0;
      }
      if (s >= threshold) { union(i, j); sims[i][j] = s; sims[j][i] = s; }
    }
  }

  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const clusters = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    let sum = 0, count = 0;
    for (let a = 0; a < idxs.length; a++)
      for (let b = a + 1; b < idxs.length; b++)
        if (sims[idxs[a]][idxs[b]] !== undefined) { sum += sims[idxs[a]][idxs[b]]; count++; }
    clusters.push({ similarity: count ? sum / count : 1, members: idxs.map((i) => items[i]) });
  }
  return clusters.sort((x, y) => y.similarity - x.similarity);
}

export function findOutliers(items, { minLines, minNesting }) {
  return items
    .filter((r) => r.lines >= minLines || r.nesting >= minNesting)
    .sort((a, b) => b.lines - a.lines);
}

// ---------------------------------------------------------------------------
// Real embedder (transformers.js). Batched; onnxruntime parallelizes a batch.
// ---------------------------------------------------------------------------

export async function makeEmbedder(modelId, dtype = DEFAULT_DTYPE) {
  // Lazy: the model is loaded only on the first region that actually needs
  // embedding, so a fully-cached (warm) scan never imports ORT or the model.
  let extractor = null;
  const load = async () => {
    if (extractor) return extractor;
    const { pipeline } = await import('@huggingface/transformers');
    // Single-threaded: deterministic, and avoids an onnxruntime-node
    // thread-pool destructor crash on exit (macOS "mutex lock failed").
    extractor = await pipeline('feature-extraction', modelId, {
      dtype,
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
    });
    return extractor;
  };
  const embed = async (texts) => {
    if (!texts.length) return [];
    const ex = await load();
    const out = [];
    const B = 32;
    for (let i = 0; i < texts.length; i += B) {
      const t = await ex(texts.slice(i, i + B), { pooling: 'mean', normalize: true });
      for (const v of t.tolist()) out.push(v);
    }
    return out;
  };
  // Release ORT sessions before exit if the model was ever loaded.
  embed.close = async () => { if (extractor) { try { await extractor.dispose?.(); } catch { /* ignore */ } } };
  return embed;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const loc = (m) => `${m.file}:${m.startLine}-${m.endLine}`;
const indexPathFor = (root) => join(root, '.dupcache', 'index.json');

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const ref = (m) => (m.name ? `${loc(m)} ${m.name}` : loc(m));

export function formatClusters(clusters, { show }) {
  return clusters.map((c) => {
    let line = `${c.similarity.toFixed(2)}  ${c.members.map(ref).join('  <->  ')}`;
    if (show) line += '\n' + c.members[0].text.split('\n').slice(0, 6).map((l) => '    ' + l).join('\n');
    return line;
  }).join('\n');
}

async function cmdScan(root, f) {
  const modelId = String(f.model || DEFAULT_MODEL);
  const threshold = f.threshold ? Number(f.threshold) : DEFAULT_THRESHOLD;
  const limit = f.limit ? Number(f.limit) : 50;
  const embed = await makeEmbedder(modelId, String(f.dtype || DEFAULT_DTYPE));
  const { regions, vectors } = await reindex(root, { modelId, indexPath: indexPathFor(root), embed });
  await embed.close?.();
  let clusters = findClusters(regions, vectors, threshold);
  let outliers = findOutliers(regions, { minLines: 60, minNesting: 5 });
  let noChanges = false;
  if (f.changed) { // keep only findings that touch the working diff
    const set = changedFiles(root);
    noChanges = set.size === 0;
    clusters = clusters.filter((c) => c.members.some((m) => set.has(m.file)));
    outliers = outliers.filter((o) => set.has(o.file));
  }
  clusters = clusters.slice(0, limit);
  outliers = outliers.slice(0, limit);

  if (f.json) { console.log(JSON.stringify({ clusters, outliers }, null, 2)); }
  else if (noChanges) { console.error('no changed files in the working tree'); }
  else if (!clusters.length && !outliers.length) { console.error(`clean, ${regions.length} regions, no duplicates`); }
  else {
    if (clusters.length) console.log(formatClusters(clusters, { show: Boolean(f.show) }));
    for (const o of outliers) console.log(`outlier  ${loc(o)}  (${o.lines} lines, nesting ${o.nesting})  ${o.name}`);
  }
  return clusters.length ? 1 : 0;
}

async function cmdSimilar(root, target, f) {
  const modelId = String(f.model || DEFAULT_MODEL);
  const limit = f.limit ? Number(f.limit) : 10;
  const embed = await makeEmbedder(modelId, String(f.dtype || DEFAULT_DTYPE));
  const { regions, vectors } = await reindex(root, { modelId, indexPath: indexPathFor(root), embed });

  let queryVec, self = null;
  if (target === '-') {
    queryVec = (await embed([await readStdin()]))[0];
  } else {
    const [file, lineStr] = target.split(':');
    const line = Number(lineStr);
    const inFile = await extractFile(root, file);
    const region = inFile.find((r) => r.startLine <= line && line <= r.endLine);
    if (!region) { console.error(`no region at ${target}`); return 2; }
    self = region.hash;
    queryVec = vectors.get(region.hash) ?? (await embed([region.text]))[0];
  }

  await embed.close?.();
  const ranked = regions
    .filter((r) => r.hash !== self)
    .map((r) => ({ r, s: cosine(queryVec, vectors.get(r.hash) || []) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);

  if (f.json) console.log(JSON.stringify(ranked.map((x) => ({ ...x.r, similarity: x.s })), null, 2));
  else for (const { r, s } of ranked) console.log(`${s.toFixed(2)}  ${loc(r)}  ${r.name}`);
  return 0;
}

async function cmdWatch(root, f) {
  const { default: chokidar } = await import('chokidar');
  const modelId = String(f.model || DEFAULT_MODEL);
  const embed = await makeEmbedder(modelId, String(f.dtype || DEFAULT_DTYPE));
  const refresh = async () => {
    const { stats } = await reindex(root, { modelId, indexPath: indexPathFor(root), embed });
    console.error(`index warm — embedded ${stats.embedded}, reused ${stats.reused}, skipped ${stats.skippedFiles}`);
  };
  await refresh();
  let timer = null;
  chokidar.watch(root, { ignored: /node_modules|\.git|\.dupcache|dist/, ignoreInitial: true })
    .on('all', () => { clearTimeout(timer); timer = setTimeout(refresh, 200); });
  console.error(`watching ${root} … (ctrl-c to stop)`);
  return new Promise(() => {}); // until killed
}

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      threshold: { type: 'string' }, limit: { type: 'string' }, model: { type: 'string' },
      dtype: { type: 'string' }, changed: { type: 'boolean' },
      show: { type: 'boolean' }, json: { type: 'boolean' },
    },
  });
  const [cmd, arg] = positionals;
  switch (cmd) {
    case 'scan': return cmdScan(arg || '.', values);
    case 'watch': return cmdWatch(arg || '.', values);
    case 'similar':
      if (!arg) { console.error('usage: dupscan similar <file:line | ->'); return 2; }
      return cmdSimilar('.', arg, values);
    default:
      console.error('usage: dupscan <scan|similar|watch> [path|target] [--changed --threshold --limit --model --show --json]');
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
