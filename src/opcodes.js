'use strict';
/**
 * objdump prints decorated mnemonics (`ldrlt.w`, `movs`, `beq.n`, `ittt`, `movzbl`, `c.addi`),
 * while Compiler Explorer documents base opcodes (`LDR`, `MOV`, `B`, `IT`, `MOVZX`, `ADDI`).
 * candidates() returns the lookups to try, most specific first.
 */

const MAX_CANDIDATES = 6;

// "    1e0a:\tf7fe ff8e \tbl\td2a <foo>"  ->  mnemonic "bl"
const RE_MNEMONIC = /^(\s+[0-9a-f]+:\t[^\t]*\t)(\S+)/;

/** @returns {{mnemonic: string, start: number, end: number}|null} */
function extractMnemonic(line) {
  const m = RE_MNEMONIC.exec(line);
  if (!m) return null;
  const mnemonic = m[2].toLowerCase();
  // directives (.word, .short ...) and "<UNDEFINED>" have no documentation
  if (!/^[a-z][a-z0-9._]*$/.test(mnemonic)) return null;
  return { mnemonic, start: m[1].length, end: m[1].length + m[2].length };
}

const CONDS = ['eq', 'ne', 'cs', 'hs', 'cc', 'lo', 'mi', 'pl', 'vs', 'vc', 'hi', 'ls', 'ge', 'lt', 'gt', 'le', 'al'];
const COND_ALT = CONDS.join('|');
const RE_ARM_BRANCH = new RegExp(`^(bxj|blx|bl|bx|b)(?:${COND_ALT})?$`);

function pushUnique(out, s) {
  if (s && !out.includes(s)) out.push(s);
}

function armCandidates(m) {
  const out = [];
  pushUnique(out, m);

  const br = RE_ARM_BRANCH.exec(m.split('.')[0]);
  if (br) { pushUnique(out, br[1]); return out; }

  const base = m.split('.')[0];              // ldrlt.w -> ldrlt ; vadd.f32 -> vadd ; b.eq -> b
  pushUnique(out, base);

  const stripCond = (s) => {
    for (const c of CONDS) if (s.length - c.length >= 3 && s.endsWith(c)) return s.slice(0, -c.length);
    return null;
  };
  const stripS = (s) => (s.length > 3 && s.endsWith('s') ? s.slice(0, -1) : null);

  // UAL order is <op>{S}{cond}: "addseq" = add + s + eq, "movs" = mov + s
  const noS = stripS(base);
  const noCond = stripCond(base);
  pushUnique(out, noS);
  pushUnique(out, noCond);
  if (noCond) pushUnique(out, stripS(noCond));

  // families whose size/addressing suffix is part of the mnemonic
  const root = noCond || base;
  let f;
  if ((f = /^(ldr|str)(?:s?[bh]|d|ex[bhd]?|bt|ht|sbt|sht|t)$/.exec(root))) pushUnique(out, f[1]);
  if ((f = /^(ldm|stm)(?:ia|ib|da|db|fd|fa|ed|ea)$/.exec(root))) pushUnique(out, f[1]);
  if (/^it[te]{0,3}$/.test(base)) pushUnique(out, 'it');
  return out;
}

const X86_ALIASES = {
  movzbl: 'movzx', movzwl: 'movzx', movzbw: 'movzx', movzbq: 'movzx', movzwq: 'movzx',
  movsbl: 'movsx', movswl: 'movsx', movsbw: 'movsx', movsbq: 'movsx', movswq: 'movsx', movslq: 'movsxd',
  cltq: 'cdqe', cqto: 'cqo', cltd: 'cdq', cwtl: 'cwde', cbtw: 'cbw', cwtd: 'cwd',
};

function amd64Candidates(m) {
  const out = [];
  pushUnique(out, m);
  pushUnique(out, X86_ALIASES[m]);
  // AT&T operand-size suffix: pushq, callq, movl, addq, nopw ...
  if (m.length > 2 && /[bwlq]$/.test(m)) pushUnique(out, m.slice(0, -1));
  return out;
}

function dottedCandidates(m) {
  const out = [];
  pushUnique(out, m);
  if (/^c\./.test(m)) pushUnique(out, m.slice(2).split('.')[0]);   // RISC-V compressed: c.addi -> addi
  pushUnique(out, m.split('.')[0]);                                 // b.eq -> b ; fadd.s -> fadd
  return out;
}

/**
 * @param {string} arch Compiler Explorer instruction set id
 * @param {string} mnemonic as printed by objdump (any case)
 * @returns {string[]} opcodes to look up, most specific first (lower-case)
 */
function candidates(arch, mnemonic) {
  const m = (mnemonic || '').toLowerCase();
  if (!m) return [];
  let out;
  switch ((arch || '').toLowerCase()) {
    case 'arm32':
      out = armCandidates(m);
      break;
    case 'aarch64':
      out = dottedCandidates(m);
      break;
    case 'amd64':
      out = amd64Candidates(m);
      break;
    default:
      out = dottedCandidates(m);
  }
  return out.slice(0, MAX_CANDIDATES);
}

module.exports = { extractMnemonic, candidates, MAX_CANDIDATES };
