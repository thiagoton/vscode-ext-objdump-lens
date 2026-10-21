'use strict';
/**
 * Line classifier + structure extractor for `objdump -S` / `objdump -d -S` /
 * GNU `.lss` listings. Pure JS (no `vscode` import) so it can be unit-tested
 * with plain Node.
 *
 * Layout of an objdump -S listing:
 *
 *   00000418 <main>:                      <- function header
 *   int main(void)                        <- C/C++ source (no fixed prefix)
 *   {
 *       1e04:\tb580      \tpush\t{r7, lr}  <- asm: "<addr>:<TAB><bytes><TAB><insn>"
 *       1e06:\tb08e      \tsub\tsp, #56\t@ 0x38
 *   	...                                 <- padding / skipped zeros
 */

const KIND = Object.freeze({
  BLANK: 0,
  SOURCE: 1,
  ASM: 2,
  HEADER: 3,   // "00000418 <main>:"
  SECTION: 4,  // "Disassembly of section .text:"
  META: 5,     // "foo.elf:     file format elf32-littlearm"
});

// "    1e04:\tb580 ..." (objdump uses a TAB; tolerate 2+ spaces from copy/paste)
const RE_ASM = /^\s+([0-9a-f]+):(?:\t| {2,})/;
// "\t..."  (zero-padding marker objdump prints for skipped runs)
const RE_DOTS = /^\t\.\.\.\s*$/;
const RE_HEADER = /^([0-9a-f]{8,16}) <(.+)>:\s*$/;
const RE_SECTION = /^Disassembly of section (\S+):\s*$/;
const RE_META = /^.+:\s+file format\s+(\S+)\s*$/;
// column where the mnemonic starts: after "<addr>:<TAB><bytes><ws><TAB>"
const RE_MNEMONIC_COL = /^\s+[0-9a-f]+:\t[^\t]*\t/;

function classify(line) {
  if (line.length === 0 || /^\s*$/.test(line)) return KIND.BLANK;
  if (RE_ASM.test(line) || RE_DOTS.test(line)) return KIND.ASM;
  const c = line.charCodeAt(0);
  // Headers / meta lines always start in column 0.
  if (c !== 32 && c !== 9) {
    if (RE_HEADER.test(line)) return KIND.HEADER;
    if (RE_SECTION.test(line)) return KIND.SECTION;
    if (RE_META.test(line)) return KIND.META;
  }
  return KIND.SOURCE;
}

const normAddr = (hex) => hex.toLowerCase().replace(/^0+(?=.)/, '');

/**
 * @param {string[]} lines document lines without EOL characters
 */
function parse(lines) {
  const n = lines.length;
  const kinds = new Array(n);
  for (let i = 0; i < n; i++) kinds[i] = classify(lines[i]);

  const functions = [];   // {name, addr, line, end}
  const sections = [];    // {name, line, end}
  const symbols = new Map();      // name -> function
  const addrToLine = new Map();   // normalised hex addr -> line
  const asmLines = [];            // {line, col}  col = mnemonic start column
  const sourceLines = [];
  const headerLines = [];
  let fileFormat = null; // BFD target from "foo.elf:     file format elf32-littlearm"

  for (let i = 0; i < n; i++) {
    const k = kinds[i];
    if (k === KIND.SOURCE) sourceLines.push(i);
    else if (k === KIND.META) {
      if (!fileFormat) fileFormat = RE_META.exec(lines[i])[1];
    }
    else if (k === KIND.HEADER) {
      const m = RE_HEADER.exec(lines[i]);
      const fn = { name: m[2], addr: normAddr(m[1]), line: i, end: i };
      functions.push(fn);
      headerLines.push(i);
      if (!symbols.has(fn.name)) symbols.set(fn.name, fn);
      if (!addrToLine.has(fn.addr)) addrToLine.set(fn.addr, i);
    } else if (k === KIND.SECTION) {
      sections.push({ name: RE_SECTION.exec(lines[i])[1], line: i, end: i });
    } else if (k === KIND.ASM) {
      const m = RE_ASM.exec(lines[i]);
      if (m) {
        addrToLine.set(normAddr(m[1]), i);
        const mc = RE_MNEMONIC_COL.exec(lines[i]);
        asmLines.push({ line: i, col: mc ? mc[0].length : m[0].length });
      } else {
        asmLines.push({ line: i, col: 0 });
      }
    }
  }

  // Extents of sections and functions (trailing blanks trimmed).
  const lastNonBlank = (from, to) => {
    let e = to;
    while (e > from && kinds[e] === KIND.BLANK) e--;
    return e;
  };
  for (let s = 0; s < sections.length; s++) {
    const limit = s + 1 < sections.length ? sections[s + 1].line - 1 : n - 1;
    sections[s].end = lastNonBlank(sections[s].line, limit);
  }
  for (let f = 0; f < functions.length; f++) {
    let limit = f + 1 < functions.length ? functions[f + 1].line - 1 : n - 1;
    // a section header between two functions also terminates the function
    for (const s of sections) {
      if (s.line > functions[f].line && s.line - 1 < limit) limit = s.line - 1;
    }
    functions[f].end = lastNonBlank(functions[f].line, limit);
  }

  // Asm runs: maximal sequences of consecutive ASM lines. Each run is anchored
  // to the nearest preceding C/C++ line, which is the line that stays visible
  // when the run is folded.
  const runs = []; // {start, first, last, count, anchorLen, fn}
  let fi = 0;
  for (let i = 0; i < n; ) {
    if (kinds[i] !== KIND.ASM) { i++; continue; }
    let j = i;
    let count = 0;
    while (j < n && kinds[j] === KIND.ASM) {
      if (!RE_DOTS.test(lines[j])) count++;
      j++;
    }
    let k = i - 1;
    while (k >= 0 && kinds[k] === KIND.BLANK) k--;
    // Runs that directly follow a function header have no C line to anchor on;
    // the function-level fold already covers them.
    const start = k >= 0 && kinds[k] === KIND.SOURCE ? k : -1;
    while (fi < functions.length && functions[fi].end < i) fi++;
    const inFn = fi < functions.length && functions[fi].line <= i ? fi : -1;
    runs.push({
      start, first: i, last: j - 1, count,
      anchorLen: start >= 0 ? lines[start].length : 0,
      fn: inFn,
    });
    i = j;
  }

  // Folding: section > function > asm run (properly nested).
  const folding = [];
  for (const s of sections) if (s.end > s.line) folding.push({ start: s.line, end: s.end });
  for (const f of functions) if (f.end > f.line) folding.push({ start: f.line, end: f.end });
  for (const r of runs) if (r.start >= 0 && r.last > r.start) folding.push({ start: r.start, end: r.last });
  folding.sort((a, b) => a.start - b.start || b.end - a.end);

  return { kinds, fileFormat, functions, sections, symbols, addrToLine, asmLines, sourceLines, headerLines, runs, folding };
}

/** Resolve "<name>" / "<name+0xNN>" to a line number, or -1. */
function resolveSymbol(model, name, offsetHex) {
  const fn = model.symbols.get(name);
  if (!fn) return -1;
  if (offsetHex) {
    const target = (BigInt('0x' + fn.addr) + BigInt('0x' + offsetHex)).toString(16);
    const l = model.addrToLine.get(target);
    if (l !== undefined) return l;
  }
  return fn.line;
}

module.exports = { KIND, classify, parse, resolveSymbol };
