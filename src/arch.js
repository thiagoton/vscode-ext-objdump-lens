'use strict';
/**
 * Instruction-set handling for the Compiler Explorer opcode-documentation lookup
 * (GET /api/asm/<instructionSet>/<opcode>).
 *
 * `docs: true` marks sets for which Compiler Explorer is known to ship opcode docs;
 * other sets are valid CE instruction sets, but a lookup may simply return "not found".
 */

const INSTRUCTION_SETS = [
  { id: 'arm32', label: 'ARM / Thumb (32-bit)', docs: true },
  { id: 'aarch64', label: 'AArch64 (ARM 64-bit)', docs: true },
  { id: 'amd64', label: 'x86 / x86-64', docs: true },
  { id: 'avr', label: 'AVR', docs: true },
  { id: '6502', label: 'MOS 6502', docs: true },
  { id: 'riscv32', label: 'RISC-V 32-bit' },
  { id: 'riscv64', label: 'RISC-V 64-bit' },
  { id: 'mips', label: 'MIPS' },
  { id: 'powerpc', label: 'PowerPC' },
  { id: 'msp430', label: 'MSP430' },
  { id: 'm68k', label: 'Motorola 68000' },
  { id: 's390x', label: 'IBM s390x' },
  { id: 'sparc', label: 'SPARC' },
  { id: 'sh', label: 'SuperH' },
  { id: 'wasm32', label: 'WebAssembly' },
  { id: 'xtensa', label: 'Xtensa' },
  { id: 'loongarch', label: 'LoongArch' },
  { id: 'ebpf', label: 'eBPF' },
  { id: 'c6x', label: 'TI C6x' },
  { id: 'kvx', label: 'Kalray KVX' },
  { id: 'mrisc32', label: 'MRISC32' },
  { id: 'vax', label: 'VAX' },
];

/**
 * Map the BFD target name from "foo.elf:     file format elf32-littlearm" to a CE instruction set.
 * @param {string|null|undefined} fmt
 * @returns {string|null}
 */
function detectFromFileFormat(fmt) {
  if (!fmt) return null;
  const f = fmt.toLowerCase();
  if (/aarch64|arm64/.test(f)) return 'aarch64';
  if (/riscv/.test(f)) return /(^|[^0-9])64/.test(f) ? 'riscv64' : 'riscv32';
  if (/arm/.test(f)) return 'arm32';
  if (/x86-64|x86_64|i386|i686|amd64/.test(f)) return 'amd64';
  if (/avr/.test(f)) return 'avr';
  if (/mips/.test(f)) return 'mips';
  if (/powerpc|ppc/.test(f)) return 'powerpc';
  if (/msp430/.test(f)) return 'msp430';
  if (/m68k/.test(f)) return 'm68k';
  if (/s390/.test(f)) return 's390x';
  if (/sparc/.test(f)) return 'sparc';
  if (/wasm/.test(f)) return 'wasm32';
  if (/xtensa/.test(f)) return 'xtensa';
  if (/loongarch/.test(f)) return 'loongarch';
  if (/bpf/.test(f)) return 'ebpf';
  if (/c6x|tic6x/.test(f)) return 'c6x';
  if (/kvx/.test(f)) return 'kvx';
  if (/mrisc32/.test(f)) return 'mrisc32';
  if (/vax/.test(f)) return 'vax';
  if (/^elf\d+-(?:little|big)?sh|^elf\d+-sh/.test(f)) return 'sh';
  return null;
}

const normalizeArch = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const isAuto = (s) => !normalizeArch(s) || normalizeArch(s) === 'auto';

/**
 * Precedence (highest first):
 *   1. per-file choice made with "Select Architecture for This File"
 *   2. disasmLens.architecture.fileAssociations (glob -> arch)
 *   3. disasmLens.architecture.default (unless "auto")
 *   4. auto-detection from the listing's "file format" line
 *
 * @returns {{arch: string|null, source: 'file'|'glob'|'setting'|'detected'|null, detail?: string}}
 */
function resolveArchitecture({ fileOverride, globMatch, setting, fileFormat }) {
  if (!isAuto(fileOverride)) return { arch: normalizeArch(fileOverride), source: 'file' };
  if (!isAuto(globMatch)) return { arch: normalizeArch(globMatch), source: 'glob' };
  if (!isAuto(setting)) return { arch: normalizeArch(setting), source: 'setting' };
  const d = detectFromFileFormat(fileFormat);
  if (d) return { arch: d, source: 'detected', detail: fileFormat };
  return { arch: null, source: null };
}

module.exports = { INSTRUCTION_SETS, detectFromFileFormat, resolveArchitecture, normalizeArch, isAuto };
