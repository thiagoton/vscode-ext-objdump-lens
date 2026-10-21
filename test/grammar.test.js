'use strict';
// Sanity checks for the TextMate grammar without needing vscode-textmate:
//  1. every regex compiles (JS regex is a superset of what we use from Oniguruma)
//  2. the key line-level rules match the right lines and capture the right fields
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const g = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'syntaxes', 'disasm.tmLanguage.json'), 'utf8'));

let count = 0;
(function walk(o) {
  if (Array.isArray(o)) return o.forEach(walk);
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (['match', 'begin', 'end'].includes(k) && typeof v === 'string') { new RegExp(v); count++; }
      else walk(v);
    }
  }
})(g);
console.log(`compiled ${count} regexes`);

const R = (name) => new RegExp(g.repository[name].match);

const asm = R('asm-line');
let m = asm.exec('    1e0a:\tf7fe ff8e \tbl\td2a <BOARD_InitBootPins>');
assert.ok(m); assert.deepStrictEqual([m[2], m[4], m[5], m[6]], ['1e0a', 'f7fe ff8e', 'bl', 'd2a <BOARD_InitBootPins>']);
m = asm.exec('    1e06:\tb08e      \tsub\tsp, #56\t@ 0x38');
assert.ok(m); assert.deepStrictEqual([m[5], m[6]], ['sub', 'sp, #56\t@ 0x38']);
m = asm.exec('     456:\tf3af 8000 \tnop.w');
assert.ok(m); assert.strictEqual(m[5], 'nop.w'); assert.strictEqual(m[6], undefined);
m = asm.exec('     46c:\t00080000 \t.word\t0x00080000');
assert.ok(m); assert.strictEqual(m[5], '.word');
m = asm.exec('  4004f6:\t55                   \tpush   %rbp');           // x86 AT&T
assert.ok(m); assert.deepStrictEqual([m[5], m[6]], ['push', '%rbp']);

assert.ok(R('function-header').test('00000418 <_mainCRTStartup>:'));
assert.ok(R('section-header').test('Disassembly of section .text:'));
assert.ok(R('file-header').test('C:/Users/x/hello_world.elf:     file format elf32-littlearm'));

// the C-line rule must NOT claim asm lines, headers or padding...
const src = R('source-line');
for (const l of ['    1e04:\tb580      \tpush\t{r7, lr}', '00001e04 <main>:', '\t...', 'Disassembly of section .text:',
                 'C:/x/hello.elf:     file format elf32-littlearm', '']) assert.ok(!src.test(l), `source rule matched: ${JSON.stringify(l)}`);
// ...but must claim real C lines, including ones that merely look similar
for (const l of ['int main(void)', '{', '    *buf++ = *p++;', '    default:', '    case 0xA:', '#endif', ' * @brief Main function', '    abc = 3;']) assert.ok(src.test(l), `source rule missed: ${JSON.stringify(l)}`);

// doc-comment rule vs pointer deref
const cpat = g.repository.c.patterns;
const doc = new RegExp(cpat.find((p) => p.name === 'comment.block.documentation.c').match);
assert.ok(doc.test(' * @brief Main function')); assert.ok(doc.test(' */')); assert.ok(!doc.test('    *buf++ = *p++;'));
console.log('grammar OK');
