'use strict';
// Tests for architecture resolution, opcode candidates, hover formatting and the cached CE client.
// The client is exercised against a local HTTP server that mimics GET /api/asm/<set>/<opcode>.
const assert = require('assert');
const http = require('http');
const { detectFromFileFormat, resolveArchitecture } = require('../src/arch');
const { extractMnemonic, candidates } = require('../src/opcodes');
const { htmlToMarkdown, buildHoverMarkdown } = require('../src/hover-format');
const { DocsClient } = require('../src/docs-client');

// ---- architecture -----------------------------------------------------------------
const det = detectFromFileFormat;
assert.strictEqual(det('elf32-littlearm'), 'arm32');
assert.strictEqual(det('elf32-bigarm'), 'arm32');
assert.strictEqual(det('elf64-littleaarch64'), 'aarch64');
assert.strictEqual(det('elf64-x86-64'), 'amd64');
assert.strictEqual(det('elf32-i386'), 'amd64');
assert.strictEqual(det('elf32-avr'), 'avr');
assert.strictEqual(det('elf32-littleriscv'), 'riscv32');
assert.strictEqual(det('elf64-littleriscv'), 'riscv64');
assert.strictEqual(det('elf32-sh'), 'sh');
assert.strictEqual(det('something-unknown'), null);
assert.strictEqual(det(null), null);

const R = resolveArchitecture;
assert.deepStrictEqual(R({ fileFormat: 'elf32-littlearm' }), { arch: 'arm32', source: 'detected', detail: 'elf32-littlearm' });
assert.strictEqual(R({ fileFormat: 'elf32-littlearm', setting: 'aarch64' }).arch, 'aarch64');
assert.strictEqual(R({ setting: 'aarch64', globMatch: 'avr' }).source, 'glob');
assert.strictEqual(R({ setting: 'aarch64', globMatch: 'avr', fileOverride: 'AMD64' }).arch, 'amd64');
assert.strictEqual(R({ setting: 'auto' }).arch, null);

// ---- mnemonic extraction -------------------------------------------------------------
const line = '    1e0a:\tf7fe ff8e \tbl\td2a <BOARD_InitBootPins>';
let m = extractMnemonic(line);
assert.strictEqual(m.mnemonic, 'bl');
assert.strictEqual(line.slice(m.start, m.end), 'bl');
assert.strictEqual(extractMnemonic('     46c:\t00080000 \t.word\t0x00080000'), null);
assert.strictEqual(extractMnemonic('\t...'), null);
assert.strictEqual(extractMnemonic('int main(void)'), null);
assert.strictEqual(extractMnemonic('  4004f6:\t55                   \tpush   %rbp').mnemonic, 'push');

// ---- candidates ------------------------------------------------------------------------
const C = (a, x) => candidates(a, x);
assert.deepStrictEqual(C('arm32', 'ldr'), ['ldr']);
assert.deepStrictEqual(C('arm32', 'ldrlt.w'), ['ldrlt.w', 'ldrlt', 'ldr']);
assert.deepStrictEqual(C('arm32', 'beq.n'), ['beq.n', 'b']);
assert.deepStrictEqual(C('arm32', 'bls'), ['bls', 'b']);         // b+ls, not bl+s
assert.deepStrictEqual(C('arm32', 'bleq'), ['bleq', 'bl']);
assert.deepStrictEqual(C('arm32', 'blx'), ['blx']);
assert.ok(C('arm32', 'movs').slice(0, 3).join() === 'movs,mov,mo' || C('arm32', 'movs')[1] === 'mov');
assert.ok(C('arm32', 'addseq').includes('add'));
assert.ok(C('arm32', 'ldrb.w').includes('ldr'));
assert.ok(C('arm32', 'ldrsh').includes('ldr'));
assert.ok(C('arm32', 'stmdb').includes('stm'));
assert.ok(C('arm32', 'ittt').includes('it'));
assert.ok(C('arm32', 'vadd.f32').includes('vadd'));
assert.deepStrictEqual(C('aarch64', 'b.eq'), ['b.eq', 'b']);
assert.deepStrictEqual(C('amd64', 'movzbl'), ['movzbl', 'movzx', 'movzb']);
assert.deepStrictEqual(C('amd64', 'pushq'), ['pushq', 'push']);
assert.deepStrictEqual(C('riscv32', 'c.addi'), ['c.addi', 'addi', 'c']);
for (const x of ['ldrlt.w', 'addseq', 'bleq', 'movs']) assert.ok(C('arm32', x).length <= 6);

// ---- hover formatting ---------------------------------------------------------------------
const md = htmlToMarkdown('<p>Load &amp; store <code>Rt</code> *x*.</p><p>Second <xref linkend="a">CPACR</xref> para &lt;ok&gt;.</p>');
assert.strictEqual(md, 'Load & store `Rt` \\*x\\*.\n\nSecond CPACR para \\<ok\\>.');
const hov = buildHoverMarkdown({ arch: 'arm32', mnemonic: 'ldrlt.w', matched: 'ldr',
  data: { tooltip: 't', html: '<p>Load Register.</p>', url: 'https://developer.arm.com/x' } });
assert.ok(hov.includes('**LDR** · `arm32`') && hov.includes('`ldrlt.w` → `ldr`') && hov.includes('[Reference](https://developer.arm.com/x)'));
assert.ok(!buildHoverMarkdown({ arch: 'x', mnemonic: 'a', matched: 'a', data: { tooltip: 't', url: 'javascript:alert(1)' } }).includes('[Reference]'));

// ---- client against a fake Compiler Explorer -------------------------------------------------
const hits = [];
let failNext = false;
const server = http.createServer((req, res) => {
  hits.push(req.url);
  assert.strictEqual(req.headers.accept, 'application/json');
  if (failNext) { failNext = false; res.statusCode = 503; return res.end('busy'); }
  const m = /^\/api\/asm\/([^/]+)\/([^/]+)$/.exec(req.url);
  if (m && m[1] === 'arm32' && m[2] === 'ldr') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ tooltip: 'Load Register', html: '<p>Load Register.</p>', url: 'https://developer.arm.com/' }));
  }
  if (m && m[1] === 'arm32' && m[2] === 'plain') { res.setHeader('Content-Type', 'text/html'); return res.end('<p>plain html</p>'); }
  res.statusCode = 404; res.end('not found');
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let persisted = {};
  let saves = 0;
  const store = { get: () => persisted, set: (v) => { persisted = JSON.parse(JSON.stringify(v)); saves++; } };
  let clock = 1_000_000;
  const mk = () => new DocsClient({ getBaseUrl: () => base + '/', store, now: () => clock });

  const c1 = mk();
  assert.strictEqual(c1.urlFor('arm32', 'b.eq'), `${base}/api/asm/arm32/b.eq`);

  // candidate fallback: ldrlt.w (404) -> ldrlt (404) -> ldr (200)
  let r = await c1.lookupFirst('arm32', ['ldrlt.w', 'ldrlt', 'ldr']);
  assert.strictEqual(r.status, 'hit'); assert.strictEqual(r.opcode, 'ldr'); assert.strictEqual(r.data.tooltip, 'Load Register');
  assert.strictEqual(hits.length, 3);

  // same URLs again: no new GETs (hits AND 404s are cached)
  r = await c1.lookupFirst('arm32', ['ldrlt.w', 'ldrlt', 'ldr']);
  assert.strictEqual(r.status, 'hit'); assert.strictEqual(hits.length, 3);
  assert.strictEqual(c1.stats.requests, 3);

  // concurrent lookups of one URL share one request
  await Promise.all([c1.lookup('arm32', 'plain'), c1.lookup('arm32', 'plain'), c1.lookup('arm32', 'plain')]);
  assert.strictEqual(hits.filter((u) => u.endsWith('/plain')).length, 1);
  assert.strictEqual((await c1.lookup('arm32', 'plain')).data.html, '<p>plain html</p>');   // non-JSON body tolerated

  // persistence: a new client (new session) reuses the stored entries without any GET
  await c1.flush();
  assert.ok(saves >= 1 && Object.keys(persisted).length === 4);
  const before = hits.length;
  const c2 = mk();
  assert.strictEqual((await c2.lookup('arm32', 'ldr')).fromCache, true);
  assert.strictEqual((await c2.lookup('arm32', 'ldrlt')).status, 'miss');
  assert.strictEqual(hits.length, before);

  // TTL: a miss expires after a day, a hit after 30 days
  clock += 25 * 3600 * 1000;
  assert.strictEqual((await mk().lookup('arm32', 'ldrlt')).fromCache, false);   // refetched
  assert.strictEqual((await mk().lookup('arm32', 'ldr')).fromCache, true);       // still fresh

  // transient errors are not persisted and are retried after 60 s
  failNext = true;
  const e1 = await c2.lookup('arm32', 'str');
  assert.strictEqual(e1.status, 'error'); assert.strictEqual(e1.message, 'HTTP 503');
  assert.ok(!Object.keys(c2.persisted).some((k) => k.endsWith('/str')));
  const n = hits.length;
  assert.strictEqual((await c2.lookup('arm32', 'str')).status, 'error');          // negative-cached in memory
  assert.strictEqual(hits.length, n);
  clock += 61 * 1000;
  assert.strictEqual((await c2.lookup('arm32', 'str')).status, 'miss');           // retried -> 404 from the fake server
  assert.strictEqual(hits.length, n + 1);

  // transport error stops the candidate loop early
  const bad = new DocsClient({ getBaseUrl: () => 'http://127.0.0.1:1', timeoutMs: 500 });
  r = await bad.lookupFirst('arm32', ['a', 'b', 'c']);
  assert.strictEqual(r.status, 'error'); assert.deepStrictEqual(r.tried, ['a']);

  // changing the server URL means different URLs -> separate cache entries
  const other = new DocsClient({ getBaseUrl: () => base.replace('127.0.0.1', 'localhost') });
  assert.strictEqual((await other.lookup('arm32', 'ldr')).fromCache, false);

  await c2.clear();
  assert.deepStrictEqual(persisted, {});
  server.close();
  console.log('docs tests OK');
})().catch((e) => { console.error(e); process.exit(1); });
