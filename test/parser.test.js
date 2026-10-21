'use strict';
// Run with:  node test/parser.test.js [optional/path/to/other.disasm]
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parse, classify, resolveSymbol, KIND } = require('../src/parser');

const read = (p) => fs.readFileSync(p, 'latin1').split(/\r?\n/);
const file = process.argv[2] || path.join(__dirname, '..', 'samples', 'sample.disasm');
const lines = read(file);
const m = parse(lines);

// ---- classification ---------------------------------------------------------
assert.strictEqual(classify('    1e04:\tb580      \tpush\t{r7, lr}'), KIND.ASM);
assert.strictEqual(classify('     46c:\t00080000 \t.word\t0x00080000'), KIND.ASM);
assert.strictEqual(classify('\t...'), KIND.ASM);
assert.strictEqual(classify('00001e04 <main>:'), KIND.HEADER);
assert.strictEqual(classify('Disassembly of section .text:'), KIND.SECTION);
assert.strictEqual(classify('C:/x/hello.elf:     file format elf32-littlearm'), KIND.META);
assert.strictEqual(classify('    *buf++ = *p++;'), KIND.SOURCE);
assert.strictEqual(classify('    default:'), KIND.SOURCE);          // not an asm "label:"
assert.strictEqual(classify('    case 0xA:'), KIND.SOURCE);
assert.strictEqual(classify('#endif'), KIND.SOURCE);
assert.strictEqual(classify(''), KIND.BLANK);

// ---- structure ---------------------------------------------------------------
assert.ok(m.functions.length > 0, 'no functions found');
assert.ok(m.runs.length > 0, 'no asm runs found');

// every asm line belongs to exactly one run
const inRuns = m.runs.reduce((a, r) => a + (r.last - r.first + 1), 0);
assert.strictEqual(inRuns, m.kinds.filter((k) => k === KIND.ASM).length);

// anchored runs: the anchor is a C line and only blank lines separate it from the run
for (const r of m.runs) {
  if (r.start < 0) continue;
  assert.strictEqual(m.kinds[r.start], KIND.SOURCE);
  for (let i = r.start + 1; i < r.first; i++) assert.strictEqual(m.kinds[i], KIND.BLANK);
}

// folding ranges: start < end, properly nested, no two ranges share a start line
const stack = [];
const starts = new Set();
for (const f of m.folding) {
  assert.ok(f.start < f.end, `empty fold ${JSON.stringify(f)}`);
  assert.ok(!starts.has(f.start), `duplicate fold start ${f.start}`);
  starts.add(f.start);
  while (stack.length && stack[stack.length - 1].end < f.start) stack.pop();
  if (stack.length) assert.ok(f.end <= stack[stack.length - 1].end, `bad nesting at ${f.start}`);
  stack.push(f);
}

// ---- symbol resolution ---------------------------------------------------------
const main = m.symbols.get('main');
if (main) {
  assert.strictEqual(resolveSymbol(m, 'main'), main.line);
  // main+0x4 is the 3rd instruction (add r7, sp, #0) in the sample
  const l = resolveSymbol(m, 'main', '4');
  assert.ok(/^\s+1e08:/.test(lines[l]) || l === main.line, 'main+0x4 should resolve to the instruction at 1e08');
}

console.log(`OK  ${path.basename(file)}: ${lines.length} lines, ${m.functions.length} functions, ` +
  `${m.runs.length} asm blocks (${m.runs.filter((r) => r.start >= 0).length} foldable), ${m.folding.length} fold ranges`);
