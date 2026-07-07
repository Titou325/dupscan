import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cosine, findClusters, findOutliers, extractFile, discover, reindex, formatClusters, changedFiles, SUPPORTED,
} from '../dupscan.js';

// ----- similarity -----------------------------------------------------------

const r = (hash, lines = 5, nesting = 1) =>
  ({ hash, file: hash + '.ts', startLine: 1, endLine: lines, lines, nesting });

test('cosine: identical=1, orthogonal=0, zero=0', () => {
  assert.ok(Math.abs(cosine([1, 0, 1], [1, 0, 1]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test('findClusters groups regions above threshold and sorts by similarity', () => {
  const a = r('a'), b = r('b'), c = r('c');
  const v = new Map([['a', [1, 0]], ['b', [1, 0.01]], ['c', [0, 1]]]);
  const clusters = findClusters([a, b, c], v, 0.9);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].members.map((m) => m.hash).sort(), ['a', 'b']);
  assert.ok(clusters[0].similarity > 0.9);
});

test('findClusters: identical text clusters even with a single shared vector', () => {
  const a = { ...r('dup'), file: 'x.ts' }, b = { ...r('dup'), file: 'y.ts' };
  const clusters = findClusters([a, b], new Map([['dup', [1, 2, 3]]]), 0.9);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, 2);
});

test('findClusters returns nothing when all below threshold', () => {
  const v = new Map([['a', [1, 0]], ['b', [0, 1]]]);
  assert.equal(findClusters([r('a'), r('b')], v, 0.9).length, 0);
});

test('findOutliers flags large or deeply nested regions', () => {
  const out = findOutliers([r('s', 4, 1), r('b', 200, 1), r('d', 10, 6)], { minLines: 60, minNesting: 5 });
  assert.deepEqual(out.map((o) => o.hash).sort(), ['b', 'd']);
});

test('formatClusters is one terse line per cluster, empty for none', () => {
  const line = formatClusters(
    [{ similarity: 0.94, members: [{ file: 'a.ts', startLine: 12, endLine: 40 }, { file: 'b.ts', startLine: 80, endLine: 108 }] }],
    { show: false },
  );
  assert.match(line, /0\.94/);
  assert.match(line, /a\.ts:12-40/);
  assert.equal(line.split('\n').length, 1);
  assert.equal(formatClusters([], { show: false }), '');
});

// ----- region extraction ----------------------------------------------------

test('extractFile finds functions, methods, classes in TS', async () => {
  const byName = new Map((await extractFile('test/fixtures', 'sample.ts')).map((x) => [x.name, x]));
  assert.equal(byName.get('add').kind, 'function');
  assert.equal(byName.get('Calculator').kind, 'class');
  assert.equal(byName.get('multiply').kind, 'method');
});

test('extractFile captures name-bound arrow and function-expression regions', async () => {
  const byName = new Map((await extractFile('test/fixtures', 'sample.ts')).map((x) => [x.name, x]));
  assert.equal(byName.get('iso').kind, 'function'); // const iso = () => ...
  assert.equal(byName.get('scale').kind, 'function'); // const scale = function () { ... }
  assert.equal(byName.get('onClick').kind, 'function'); // { onClick: (e) => ... }
  // Region text is the function value, not the binding name, so identical
  // bodies under different names still match.
  assert.equal(byName.get('iso').text, '() => new Date().toISOString()');
});

test('extractFile handles Python methods vs functions', async () => {
  const byName = new Map((await extractFile('test/fixtures', 'sample.py')).map((x) => [x.name, x]));
  assert.equal(byName.get('greet').kind, 'function');
  assert.equal(byName.get('Greeter').kind, 'class');
  assert.equal(byName.get('loud').kind, 'method');
});

test('region hash is stable, text-derived; nesting reflects nested blocks', async () => {
  const regions = await extractFile('test/fixtures', 'sample.ts');
  const add = regions.find((x) => x.name === 'add');
  const mult = regions.find((x) => x.name === 'multiply');
  assert.match(add.hash, /^[0-9a-f]{64}$/);
  assert.ok(mult.nesting > add.nesting);
});

test('discover returns only supported files', async () => {
  const files = await discover('test/fixtures');
  assert.ok(files.includes('sample.ts'));
  assert.ok(files.includes('sample.py'));
  assert.ok(files.every((f) => SUPPORTED.some((e) => f.endsWith(e))));
});

// ----- staleness / index (fake deterministic embedder) ----------------------

function counter() {
  let n = 0;
  return { embed: async (texts) => { n += texts.length; return texts.map((t) => [t.length, t.charCodeAt(0) || 0, 1]); }, calls: () => n };
}
const tmp = () => mkdtemp(join(tmpdir(), 'dupscan-'));

test('first reindex embeds every region', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'a.ts'), 'function f() { return 1; }\nfunction g() { return 2; }\n');
  const c = counter();
  const res = await reindex(dir, { modelId: 'fake', indexPath: join(dir, '.dupcache/i.json'), embed: c.embed });
  assert.equal(res.regions.length, 2);
  assert.equal(c.calls(), 2);
  await rm(dir, { recursive: true, force: true });
});

test('unchanged reindex embeds nothing and skips the file', async () => {
  const dir = await tmp(); const idx = join(dir, '.dupcache/i.json');
  await writeFile(join(dir, 'a.ts'), 'function f() { return 1; }\n');
  await reindex(dir, { modelId: 'fake', indexPath: idx, embed: counter().embed });
  const c = counter();
  const res = await reindex(dir, { modelId: 'fake', indexPath: idx, embed: c.embed });
  assert.equal(c.calls(), 0);
  assert.equal(res.stats.skippedFiles, 1);
  await rm(dir, { recursive: true, force: true });
});

test('touch without content change re-embeds nothing (hash beats mtime)', async () => {
  const dir = await tmp(); const idx = join(dir, '.dupcache/i.json'); const file = join(dir, 'a.ts');
  await writeFile(file, 'function f() { return 1; }\n');
  await reindex(dir, { modelId: 'fake', indexPath: idx, embed: counter().embed });
  const future = new Date(Date.now() + 60_000);
  await utimes(file, future, future);
  const c = counter();
  await reindex(dir, { modelId: 'fake', indexPath: idx, embed: c.embed });
  assert.equal(c.calls(), 0);
  await rm(dir, { recursive: true, force: true });
});

test('editing one function re-embeds only the changed region', async () => {
  const dir = await tmp(); const idx = join(dir, '.dupcache/i.json'); const file = join(dir, 'a.ts');
  await writeFile(file, 'function f() { return 1; }\nfunction g() { return 2; }\n');
  await reindex(dir, { modelId: 'fake', indexPath: idx, embed: counter().embed });
  await writeFile(file, 'function f() { return 1; }\nfunction g() { return 999; }\n');
  const c = counter();
  await reindex(dir, { modelId: 'fake', indexPath: idx, embed: c.embed });
  assert.equal(c.calls(), 1);
  await rm(dir, { recursive: true, force: true });
});

test('deleting a file GCs its vectors', async () => {
  const dir = await tmp(); const idx = join(dir, '.dupcache/i.json');
  await writeFile(join(dir, 'a.ts'), 'function f() { return 1; }\n');
  await writeFile(join(dir, 'b.ts'), 'function h() { return 3; }\n');
  await reindex(dir, { modelId: 'fake', indexPath: idx, embed: counter().embed });
  await rm(join(dir, 'b.ts'));
  const res = await reindex(dir, { modelId: 'fake', indexPath: idx, embed: counter().embed });
  assert.equal(res.vectors.size, 1);
  assert.equal(res.regions.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('changing modelId forces a full re-embed', async () => {
  const dir = await tmp(); const idx = join(dir, '.dupcache/i.json');
  await writeFile(join(dir, 'a.ts'), 'function f() { return 1; }\n');
  await reindex(dir, { modelId: 'A', indexPath: idx, embed: counter().embed });
  const c = counter();
  await reindex(dir, { modelId: 'B', indexPath: idx, embed: c.embed });
  assert.equal(c.calls(), 1);
  await rm(dir, { recursive: true, force: true });
});

test('changedFiles reports modified + untracked, not unchanged (relative to root)', async () => {
  const dir = await tmp();
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  await writeFile(join(dir, 'a.ts'), 'x');
  await writeFile(join(dir, 'b.ts'), 'y');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  await writeFile(join(dir, 'a.ts'), 'x2');    // modified tracked
  await writeFile(join(dir, 'c.ts'), 'z');     // untracked code
  await writeFile(join(dir, 'notes.md'), 'n'); // untracked non-code
  const set = changedFiles(dir);
  assert.ok(set.has('a.ts'));
  assert.ok(set.has('c.ts'));
  assert.ok(!set.has('b.ts'));       // unchanged
  assert.ok(!set.has('notes.md'));   // non-code excluded
  await rm(dir, { recursive: true, force: true });
});

test('renaming a file with identical content reuses the vector', async () => {
  const dir = await tmp(); const idx = join(dir, '.dupcache/i.json');
  await writeFile(join(dir, 'a.ts'), 'function f() { return 1; }\n');
  await reindex(dir, { modelId: 'fake', indexPath: idx, embed: counter().embed });
  await rm(join(dir, 'a.ts'));
  await writeFile(join(dir, 'renamed.ts'), 'function f() { return 1; }\n');
  const c = counter();
  const res = await reindex(dir, { modelId: 'fake', indexPath: idx, embed: c.embed });
  assert.equal(c.calls(), 0);
  assert.equal(res.regions[0].file, 'renamed.ts');
  await rm(dir, { recursive: true, force: true });
});
