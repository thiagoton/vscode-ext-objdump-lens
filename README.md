# Disassembly Lens (objdump -S)

VS Code support for interleaved source/assembly listings produced by
`arm-none-eabi-objdump -S -d`, GNU `.lss` files and similar `objdump -S` output.

![layout](https://img.shields.io/badge/format-objdump%20--S-blue)

## What it does

| Feature | Details |
|---|---|
| **C/C++ vs asm separation** | Source lines get a green marker/tint and C/C++ syntax colouring; asm lines get a blue marker/tint. Function headers (`00000418 <main>:`) are bold with an overview-ruler mark. |
| **Asm syntax highlighting** | Address, opcode bytes (dimmed), mnemonic (branches, stack ops, loads/stores get distinct scopes), registers, immediates, `<symbol+0xoff>` references, `@` comments, `.word` data. ARM/Thumb first; x86 AT&T and RISC-V also parse. |
| **Folding** | Each asm block folds into the C/C++ line that owns it. Folding is nested: section → function → asm block. |
| **Instruction counter** | `⟦ 7 insns ⟧` shown after every C/C++ line that owns an asm block (visible even when folded). |
| **Opcode docs on hover** | Hover a mnemonic to get its documentation from [Compiler Explorer](https://github.com/compiler-explorer/compiler-explorer/blob/main/docs/API.md) (`GET /api/asm/<instructionSet>/<opcode>`). Decorated forms such as `ldrlt.w`, `movs`, `beq.n`, `ittt` are mapped to base opcodes (`ldr`, `mov`, `b`, `it`). |
| **Outline + navigation** | Functions appear in Outline / breadcrumbs; F12 / Ctrl+Click on `<symbol>` or `<symbol+0x1c>` jumps to the definition. |

## Opcode documentation (Compiler Explorer)

The documentation depends on the instruction set, so each file has one:

1. **Per-file choice**: status-bar item (`$(chip) arm32`) or *Disassembly Lens: Select Architecture for This File*. Stored per file; choose *Automatic* to forget it.
2. `disasmLens.architecture.fileAssociations`: glob → instruction set, e.g. `{ "**/firmware/*.lss": "arm32" }` (shareable via `.vscode/settings.json`).
3. `disasmLens.architecture.default`: a fixed instruction set for every file (`auto` by default).
4. **Auto-detection** from the listing's `file format` line (`elf32-littlearm` → `arm32`, `elf64-x86-64` → `amd64`, `elf32-avr` → `avr`, …).

Valid ids are Compiler Explorer instruction sets (`arm32`, `aarch64`, `amd64`, `avr`, `6502`, `riscv32`, `mips`, …); the picker also accepts any custom id. CE does not have opcode documentation for every set; when it has none you get a short "no documentation" hover (`disasmLens.documentation.showNotFound`).

**Caching:** every URL is requested once. Found docs are cached for 30 days and "not found" answers for 1 day, in memory *and* in VS Code's global storage, so they survive restarts. Concurrent hovers share one request; network errors / 5xx are only remembered for 60 s and never persisted. *Clear Opcode Documentation Cache* wipes it.

**Privacy / offline:** only the instruction set and the mnemonic are sent (e.g. `/api/asm/arm32/ldr`), to `disasmLens.documentation.serverUrl` (default `https://godbolt.org`; point it at a self-hosted CE if you like). Set `disasmLens.documentation.enabled` to `false` to disable all network access.

## Commands (Command Palette → "Disassembly Lens")

* **Collapse / Expand All Assembly Blocks** (also buttons in the editor title bar)
* **Toggle All Assembly Blocks**
* **Toggle Assembly Block at Cursor** (works from any C line of the group or from the asm itself)
* **Collapse / Expand Assembly Blocks in Current Function**
* **Select Architecture for This File (opcode docs)** and **Clear Opcode Documentation Cache**

No default keybindings are set (AltGr layouts such as ABNT2 clash with `Ctrl+Alt+…`); bind them in
*Keyboard Shortcuts* if you want, e.g.

```json
{ "key": "ctrl+k ctrl+a", "command": "disasmLens.toggleAllAsm", "when": "editorLangId == disasm" }
```

## Settings

| Setting | Default | |
|---|---|---|
| `disasmLens.decorations` | `true` | Tint source/asm/header lines |
| `disasmLens.dimEncoding` | `true` | Dim address + opcode bytes |
| `disasmLens.showAsmSummary` | `true` | Instruction count after C lines |
| `disasmLens.autoCollapseOnOpen` | `false` | Fold every asm block on open |
| `disasmLens.documentation.enabled` | `true` | Opcode docs on hover (network) |
| `disasmLens.documentation.serverUrl` | `https://godbolt.org` | Compiler Explorer instance |
| `disasmLens.documentation.showNotFound` | `true` | Hover note when CE has no docs |
| `disasmLens.architecture.default` | `auto` | Instruction set for all files |
| `disasmLens.architecture.fileAssociations` | `{}` | Glob → instruction set |

Colours are theme colours and can be overridden in `workbench.colorCustomizations`:
`disasmLens.asmBackground`, `disasmLens.asmBorder`, `disasmLens.sourceBackground`,
`disasmLens.sourceBorder`, `disasmLens.functionBackground`, `disasmLens.summaryForeground`.

## Using it

Files ending in `.disasm`, `.dasm`, `.dis`, `.objdump` or `.lss` are picked up automatically. For any
other name use *Change Language Mode → Disassembly (objdump -S)*, or add
`"files.associations": { "*.txt": "disasm" }`.

Generate a listing with source interleaved (build with `-g`):

```sh
arm-none-eabi-objdump -S -d -C firmware.elf > firmware.disasm
```

## How blocks are detected

* asm line: `^\s+<hex>:<TAB>…`   (also `\t...` padding lines)
* function header: `^<hex8+> <name>:`
* everything else that is non-blank is treated as C/C++ source.

Because each source line is tokenised on its own, a free-text line in the middle of a multi-line `/* … */` comment
(one without a leading `*`) is coloured as code. This is deliberate: it keeps a stray unterminated comment from
swallowing the asm lines that follow.

## Development

```sh
node test/parser.test.js            # parser/folding invariants (optionally pass another .disasm)
node test/grammar.test.js           # grammar regex sanity
node test/docs.test.js              # architecture, opcode candidates, CE client + cache (local fake server)
node test/extension.smoke.js        # extension against a mocked vscode API
npm test                            # all of the above
```
Press **F5** in VS Code with this folder open to launch an Extension Development Host on `samples/sample.disasm`.
No build step or runtime dependencies.
