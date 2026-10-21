'use strict';
// Loads src/extension.js against a tiny mock of the `vscode` API and exercises the providers/commands.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const calls = [];
const decos = {};
const providers = {};
const commands = {};
class Range { constructor(a, b, c, d) { this.s = [a, b]; this.e = [c, d]; } }
class Position { constructor(l, c) { this.line = l; this.character = c; } }
const text = fs.readFileSync(path.join(__dirname, '..', 'samples', 'sample.disasm'), 'latin1');
const lines = text.split(/\r?\n/);
const doc = {
  languageId: 'disasm', version: 1, uri: { toString: () => 'file:///s.disasm' },
  getText: () => text, lineAt: (l) => ({ text: lines[l] }),
};
const editor = { document: doc, selection: { active: { line: 0 } }, setDecorations: (t, r) => { decos[t.id] = r; } };
let typeId = 0;
const http = require('http');
const hoverReqs = [];
const fake = http.createServer((req, res) => {
  hoverReqs.push(req.url);
  if (req.url === '/api/asm/arm32/push') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ tooltip: 'Push', html: '<p>Push multiple registers.</p>', url: 'https://example.org/push' }));
  }
  res.statusCode = 404; res.end();
});
let serverUrl = '';
const gstate = {};
const settings = { 'documentation.serverUrl': () => serverUrl };
const statusItem = { shown: false, text: '', show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} };
const quickPickAnswer = { arch: 'aarch64' };
const vscode = {
  MarkdownString: class { constructor(v) { this.value = v; } },
  Hover: class { constructor(c, r) { this.contents = c; this.range = r; } },
  StatusBarAlignment: { Right: 2 },
  QuickPickItemKind: { Separator: -1 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  OverviewRulerLane: { Left: 1 },
  FoldingRange: class { constructor(s, e, k) { Object.assign(this, { start: s, end: e, kind: k }); } },
  FoldingRangeKind: { Region: 3 },
  DocumentSymbol: class { constructor(n, d, k, r, s) { Object.assign(this, { name: n, detail: d, kind: k, range: r, selectionRange: s }); } },
  SymbolKind: { Function: 11 },
  Range, Position, Location: class { constructor(u, p) { this.uri = u; this.pos = p; } },
  window: {
    visibleTextEditors: [editor], activeTextEditor: editor,
    createTextEditorDecorationType: (o) => ({ id: ++typeId, opts: o, dispose() {} }),
    onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    showInformationMessage: (m) => calls.push(['msg', m]),
    createStatusBarItem: () => statusItem,
    showQuickPick: async (items) => items.find((i) => i.arch === quickPickAnswer.arch),
    showInputBox: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (settings[k] ? settings[k]() : d) }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  languages: {
    registerFoldingRangeProvider: (_s, p) => { providers.fold = p; return { dispose() {} }; },
    registerDocumentSymbolProvider: (_s, p) => { providers.sym = p; return { dispose() {} }; },
    registerDefinitionProvider: (_s, p) => { providers.def = p; return { dispose() {} }; },
    registerHoverProvider: (_s, p) => { providers.hover = p; return { dispose() {} }; },
    match: () => 0,
  },
  commands: {
    registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; },
    executeCommand: async (id, args) => { calls.push([id, args]); },
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension');
const ctx = {
  subscriptions: [],
  globalState: { get: (k, d) => (k in gstate ? gstate[k] : d), update: async (k, v) => { gstate[k] = v; } },
};


(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  serverUrl = `http://127.0.0.1:${fake.address().port}`;
  ext.activate(ctx);
  // folding provider
  const fr = providers.fold.provideFoldingRanges(doc);
  assert.ok(fr.length > 50);
  // symbols
  const syms = providers.sym.provideDocumentSymbols(doc);
  assert.ok(syms.some((s) => s.name === 'main'));
  // decorations: 5 types, ranges present
  assert.strictEqual(Object.keys(decos).length, 5);
  assert.ok(decos[1].length > 100 && decos[2].length > 10 && decos[3].length === 4);
  const summary = decos[5][0];
  assert.ok(/⟦ \d+ insns? ⟧/.test(summary.renderOptions.after.contentText));
  // go to definition on "bl d2a <BOARD_InitBootPins>" is a no-op if symbol missing from sample; try a <main+0x..> / <main> reference
  const refLine = lines.findIndex((l) => /<main\+0x[0-9a-f]+>/.test(l));
  if (refLine >= 0) {
    const col = lines[refLine].indexOf('<main');
    const loc = providers.def.provideDefinition(doc, new Position(refLine, col + 2));
    assert.ok(loc && loc.pos.line >= 0, 'definition should resolve <main+0x..>');
  }
  // commands
  await commands['disasmLens.collapseAllAsm']();
  const c1 = calls.find((c) => c[0] === 'editor.fold');
  assert.ok(c1 && c1[1].selectionLines.length === 54, 'collapse should target every anchored asm block');
  await commands['disasmLens.expandAllAsm']();
  assert.ok(calls.some((c) => c[0] === 'editor.unfold'));
  await commands['disasmLens.toggleAllAsm'](); await commands['disasmLens.toggleAllAsm']();
  const mainLine = lines.findIndex((l) => /^[0-9a-f]+ <main>:/.test(l));
  editor.selection.active.line = mainLine + 10;
  calls.length = 0;
  await commands['disasmLens.collapseFunctionAsm']();
  assert.ok(calls[0][1].selectionLines.length > 5);
  await commands['disasmLens.toggleAsmAtCursor']();
  assert.ok(calls.some((c) => c[0] === 'editor.toggleFold'));

  // ---- opcode documentation hover + architecture -------------------------------------------
  assert.strictEqual(statusItem.text, '$(chip) arm32', 'arch auto-detected from "file format elf32-littlearm"');
  const pushLine = lines.findIndex((l) => /^\s+[0-9a-f]+:\t[^\t]*\tpush\t/.test(l));
  assert.ok(pushLine >= 0);
  const col = lines[pushLine].indexOf('push') + 1;
  const tok = { isCancellationRequested: false };
  let h = await providers.hover.provideHover(doc, new Position(pushLine, col), tok);
  assert.ok(h.contents.value.includes('**PUSH** · `arm32`') && h.contents.value.includes('Push multiple registers'));
  assert.deepStrictEqual(hoverReqs, ['/api/asm/arm32/push']);
  await providers.hover.provideHover(doc, new Position(pushLine, col), tok);          // same URL -> cached
  assert.strictEqual(hoverReqs.length, 1, 'second hover must not issue another GET');
  // hovering over the operands (not the mnemonic) shows nothing
  assert.strictEqual(await providers.hover.provideHover(doc, new Position(pushLine, lines[pushLine].length - 1), tok), undefined);
  // unknown opcode -> "not found" hover, 404 cached
  const subLine = lines.findIndex((l) => /\tsub\t/.test(l));
  h = await providers.hover.provideHover(doc, new Position(subLine, lines[subLine].indexOf('sub') + 1), tok);
  assert.ok(h.contents.value.includes('No Compiler Explorer documentation'));
  const n = hoverReqs.length;
  await providers.hover.provideHover(doc, new Position(subLine, lines[subLine].indexOf('sub') + 1), tok);
  assert.strictEqual(hoverReqs.length, n);

  // per-file architecture choice wins over detection and is persisted
  await commands['disasmLens.selectArchitecture']();
  assert.strictEqual(statusItem.text, '$(chip) aarch64');
  assert.deepStrictEqual(Object.values(gstate['disasmLens.archByFile.v1']), ['aarch64']);
  h = await providers.hover.provideHover(doc, new Position(pushLine, col), tok);
  assert.ok(h.contents.value.includes('`aarch64`') || h.contents.value.includes('No Compiler Explorer documentation'));
  // "Automatic" clears the per-file choice again
  quickPickAnswer.arch = 'auto';
  await commands['disasmLens.selectArchitecture']();
  assert.strictEqual(statusItem.text, '$(chip) arm32');
  assert.deepStrictEqual(gstate['disasmLens.archByFile.v1'], {});
  await commands['disasmLens.clearDocCache']();
  await ext.deactivate();
  fake.close();
  console.log('extension smoke test OK');
})().catch((e) => { console.error(e); process.exit(1); });
