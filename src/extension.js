'use strict';
const vscode = require('vscode');
const { parse, resolveSymbol } = require('./parser');
const { INSTRUCTION_SETS, resolveArchitecture, normalizeArch, isAuto } = require('./arch');
const { extractMnemonic, candidates } = require('./opcodes');
const { DocsClient } = require('./docs-client');
const { buildHoverMarkdown } = require('./hover-format');

const LANG = 'disasm';
const SELECTOR = { language: LANG };

/** uri -> { version, model } */
const modelCache = new Map();
/** uri strings whose "collapse all" toggle is currently active */
const allCollapsed = new Set();
/** uri strings already auto-collapsed on open */
const autoCollapsed = new Set();

function getModel(doc) {
  const key = doc.uri.toString();
  const hit = modelCache.get(key);
  if (hit && hit.version === doc.version) return hit.model;
  const model = parse(doc.getText().split(/\r\n|\r|\n/));
  modelCache.set(key, { version: doc.version, model });
  return model;
}

const cfg = () => vscode.workspace.getConfiguration('objdumpLens');

// ---------------------------------------------------------------------------
// Decorations (theme-aware colours are contributed in package.json "colors")
// ---------------------------------------------------------------------------

function createDecorationTypes() {
  const color = (id) => new vscode.ThemeColor(id);
  const bar = (bg, border) => ({
    isWholeLine: true,
    backgroundColor: color(bg),
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: color(border),
  });
  return {
    asm: vscode.window.createTextEditorDecorationType(bar('objdumpLens.asmBackground', 'objdumpLens.asmBorder')),
    source: vscode.window.createTextEditorDecorationType(bar('objdumpLens.sourceBackground', 'objdumpLens.sourceBorder')),
    header: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: color('objdumpLens.functionBackground'),
      fontWeight: 'bold',
      overviewRulerColor: color('objdumpLens.functionBackground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
    dim: vscode.window.createTextEditorDecorationType({ opacity: '0.55' }),
    summary: vscode.window.createTextEditorDecorationType({
      after: { color: color('objdumpLens.summaryForeground'), fontStyle: 'italic', margin: '0 0 0 2em' },
    }),
  };
}

function applyDecorations(editor, types) {
  if (editor.document.languageId !== LANG) return;
  const c = cfg();
  if (!c.get('decorations', true)) {
    for (const t of Object.values(types)) editor.setDecorations(t, []);
    return;
  }
  const model = getModel(editor.document);
  const wholeLine = (l) => new vscode.Range(l, 0, l, 0);

  editor.setDecorations(types.source, model.sourceLines.map(wholeLine));
  editor.setDecorations(types.header, model.headerLines.map(wholeLine));
  editor.setDecorations(types.asm, model.asmLines.map((a) => wholeLine(a.line)));

  editor.setDecorations(
    types.dim,
    c.get('dimEncoding', true)
      ? model.asmLines.filter((a) => a.col > 0).map((a) => new vscode.Range(a.line, 0, a.line, a.col))
      : []
  );

  editor.setDecorations(
    types.summary,
    c.get('showAsmSummary', true)
      ? model.runs
          .filter((r) => r.start >= 0 && r.count > 0)
          .map((r) => ({
            range: new vscode.Range(r.start, r.anchorLen, r.start, r.anchorLen),
            renderOptions: { after: { contentText: `\u27e6 ${r.count} insn${r.count === 1 ? '' : 's'} \u27e7` } },
          }))
      : []
  );
}

// ---------------------------------------------------------------------------
// Folding helpers
// ---------------------------------------------------------------------------

async function setFold(lines, fold) {
  if (!lines.length) return;
  await vscode.commands.executeCommand(fold ? 'editor.fold' : 'editor.unfold', {
    selectionLines: lines,
    levels: 1,
    direction: 'down',
  });
}

function activeDisasmEditor() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== LANG) {
    vscode.window.showInformationMessage('ObjDump Lens: open a disassembly file (language mode "Disassembly (objdump -S)").');
    return undefined;
  }
  return ed;
}

const foldableRuns = (model) => model.runs.filter((r) => r.start >= 0 && r.last > r.start);

function currentFunctionIndex(model, line) {
  for (let i = 0; i < model.functions.length; i++) {
    const f = model.functions[i];
    if (line >= f.line && line <= f.end) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Architecture (Compiler Explorer instruction set) per file
// ---------------------------------------------------------------------------

const ARCH_BY_FILE_KEY = 'objdumpLens.archByFile.v1';
const DOC_CACHE_KEY = 'objdumpLens.docCache.v1';
let extContext;
let docsClient;

const archByFile = () => extContext.globalState.get(ARCH_BY_FILE_KEY, {});

/** Resolve the instruction set for a document and say where the choice came from. */
function getArchInfo(doc) {
  const model = getModel(doc);
  let globMatch;
  const assoc = cfg().get('architecture.fileAssociations', {}) || {};
  for (const [glob, arch] of Object.entries(assoc)) {
    if (vscode.languages.match({ pattern: glob }, doc) > 0) { globMatch = arch; break; }
  }
  return resolveArchitecture({
    fileOverride: archByFile()[doc.uri.toString()],
    globMatch,
    setting: cfg().get('architecture.default', 'auto'),
    fileFormat: model.fileFormat,
  });
}

const SOURCE_LABEL = {
  file: 'chosen for this file',
  glob: 'from objdumpLens.architecture.fileAssociations',
  setting: 'from objdumpLens.architecture.default',
  detected: 'auto-detected from the listing',
};

function updateStatusBar(item) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== LANG || !cfg().get('documentation.enabled', true)) {
    item.hide();
    return;
  }
  const info = getArchInfo(ed.document);
  item.text = info.arch ? `$(chip) ${info.arch}` : '$(chip) arch: ?';
  item.tooltip = info.arch
    ? `Instruction set used for Compiler Explorer opcode docs (${SOURCE_LABEL[info.source]}${info.detail ? ': ' + info.detail : ''}). Click to change.`
    : 'No instruction set selected for opcode documentation. Click to choose one.';
  item.show();
}

async function selectArchitecture() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== LANG) {
    vscode.window.showInformationMessage('ObjDump Lens: open a disassembly file first.');
    return;
  }
  const key = ed.document.uri.toString();
  const current = getArchInfo(ed.document);
  const items = [
    {
      label: '$(sync) Automatic',
      description: 'forget the choice for this file',
      detail: 'Uses objdumpLens.architecture.fileAssociations / default, else detects it from the "file format" line',
      arch: 'auto',
    },
    { label: 'Instruction sets', kind: vscode.QuickPickItemKind.Separator },
    ...INSTRUCTION_SETS.map((a) => ({
      label: `${current.arch === a.id ? '$(check) ' : ''}${a.id}`,
      description: a.label,
      detail: a.docs ? undefined : 'Compiler Explorer may not have opcode documentation for this set',
      arch: a.id,
    })),
    { label: '$(edit) Other…', description: 'type any Compiler Explorer instruction set id', arch: '__custom__' },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Instruction set for Compiler Explorer opcode docs',
    placeHolder: current.arch
      ? `Current: ${current.arch} (${SOURCE_LABEL[current.source]})`
      : 'Not set',
  });
  if (!pick) return;
  let arch = pick.arch;
  if (arch === '__custom__') {
    const typed = await vscode.window.showInputBox({
      prompt: 'Instruction set id as used in /api/asm/<instructionSet>/<opcode>',
      placeHolder: 'e.g. arm32',
      validateInput: (v) => (/^[a-z0-9_+.-]+$/i.test((v || '').trim()) ? undefined : 'Letters, digits and _ + . - only'),
    });
    if (!typed) return;
    arch = normalizeArch(typed);
  }
  const map = { ...archByFile() };
  if (isAuto(arch)) delete map[key];
  else map[key] = arch;
  await extContext.globalState.update(ARCH_BY_FILE_KEY, map);
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function activate(context) {
  extContext = context;
  const types = createDecorationTypes();
  context.subscriptions.push(...Object.values(types));

  // --- Compiler Explorer opcode docs --------------------------------------------
  docsClient = new DocsClient({
    getBaseUrl: () => cfg().get('documentation.serverUrl', 'https://godbolt.org'),
    store: {
      get: () => context.globalState.get(DOC_CACHE_KEY, {}),
      set: (v) => context.globalState.update(DOC_CACHE_KEY, v),
    },
  });

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.command = 'objdumpLens.selectArchitecture';
  context.subscriptions.push(statusItem);
  const refreshStatus = () => updateStatusBar(statusItem);

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(SELECTOR, {
      async provideHover(doc, pos, token) {
        const c = cfg();
        if (!c.get('documentation.enabled', true)) return undefined;
        const mn = extractMnemonic(doc.lineAt(pos.line).text);
        if (!mn || pos.character < mn.start || pos.character > mn.end) return undefined;
        const range = new vscode.Range(pos.line, mn.start, pos.line, mn.end);

        const info = getArchInfo(doc);
        if (!info.arch) {
          const md = new vscode.MarkdownString(
            'Pick an instruction set to see documentation for `' + mn.mnemonic + '`: ' +
            '[Select architecture…](command:objdumpLens.selectArchitecture)'
          );
          md.isTrusted = { enabledCommands: ['objdumpLens.selectArchitecture'] };
          return new vscode.Hover(md, range);
        }

        const cands = candidates(info.arch, mn.mnemonic);
        if (!cands.length) return undefined;
        const res = await docsClient.lookupFirst(info.arch, cands);
        if (token && token.isCancellationRequested) return undefined;

        if (res.status === 'hit') {
          const md = new vscode.MarkdownString(
            buildHoverMarkdown({ arch: info.arch, mnemonic: mn.mnemonic, matched: res.opcode, data: res.data })
          );
          return new vscode.Hover(md, range);
        }
        if (res.status === 'error') {
          return new vscode.Hover(
            new vscode.MarkdownString('_Compiler Explorer lookup failed (' + res.message + ')._'), range);
        }
        if (!c.get('documentation.showNotFound', true)) return undefined;
        return new vscode.Hover(
          new vscode.MarkdownString(
            '_No Compiler Explorer documentation for_ `' + mn.mnemonic + '` _in_ `' + info.arch +
            '` _(tried: ' + res.tried.join(', ') + ')_'),
          range);
      },
    }),
    vscode.window.onDidChangeActiveTextEditor(refreshStatus),
    vscode.workspace.onDidChangeTextDocument((e) => { if (e.document === (vscode.window.activeTextEditor || {}).document) refreshStatus(); }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('objdumpLens')) refreshStatus(); }),
    vscode.commands.registerCommand('objdumpLens.selectArchitecture', async () => {
      await selectArchitecture();
      refreshStatus();
    }),
    vscode.commands.registerCommand('objdumpLens.clearDocCache', async () => {
      await docsClient.clear();
      vscode.window.showInformationMessage('ObjDump Lens: opcode documentation cache cleared.');
    })
  );
  refreshStatus();

  // --- folding: section > function > asm block -----------------------------
  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(SELECTOR, {
      provideFoldingRanges(doc) {
        return getModel(doc).folding.map(
          (r) => new vscode.FoldingRange(r.start, r.end, vscode.FoldingRangeKind.Region)
        );
      },
    })
  );

  // --- outline: one symbol per function ------------------------------------
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, {
      provideDocumentSymbols(doc) {
        return getModel(doc).functions.map((f) => {
          const endLen = doc.lineAt(f.end).text.length;
          return new vscode.DocumentSymbol(
            f.name,
            '0x' + f.addr,
            vscode.SymbolKind.Function,
            new vscode.Range(f.line, 0, f.end, endLen),
            new vscode.Range(f.line, 0, f.line, doc.lineAt(f.line).text.length)
          );
        });
      },
    })
  );

  // --- go to definition on "<symbol>" / "<symbol+0xNN>" ---------------------
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(SELECTOR, {
      provideDefinition(doc, pos) {
        const text = doc.lineAt(pos.line).text;
        const re = /<([^<>\s+]+)(?:\+0x([0-9a-f]+))?>/g;
        let m;
        while ((m = re.exec(text))) {
          if (pos.character >= m.index && pos.character <= m.index + m[0].length) {
            const target = resolveSymbol(getModel(doc), m[1], m[2]);
            if (target >= 0 && target !== pos.line) {
              return new vscode.Location(doc.uri, new vscode.Position(target, 0));
            }
            return undefined;
          }
        }
        return undefined;
      },
    })
  );

  // --- decorations refresh --------------------------------------------------
  let timer;
  const refreshAll = () => {
    for (const ed of vscode.window.visibleTextEditors) applyDecorations(ed, types);
  };
  const refreshSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(refreshAll, 150);
  };

  const maybeAutoCollapse = (editor) => {
    if (!editor || editor.document.languageId !== LANG) return;
    if (!cfg().get('autoCollapseOnOpen', false)) return;
    const key = editor.document.uri.toString();
    if (autoCollapsed.has(key)) return;
    autoCollapsed.add(key);
    const go = () => {
      if (vscode.window.activeTextEditor !== editor) return;
      setFold(foldableRuns(getModel(editor.document)).map((r) => r.start), true);
      allCollapsed.add(key);
    };
    // folding ranges are computed asynchronously after the model opens
    setTimeout(go, 400);
    setTimeout(go, 1500);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(refreshAll),
    vscode.window.onDidChangeActiveTextEditor(maybeAutoCollapse),
    // also fires when the user switches a file to this language mode
    vscode.workspace.onDidOpenTextDocument(() => {
      refreshSoon();
      maybeAutoCollapse(vscode.window.activeTextEditor);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === LANG) refreshSoon();
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      const key = d.uri.toString();
      modelCache.delete(key);
      allCollapsed.delete(key);
      autoCollapsed.delete(key);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('objdumpLens')) refreshAll();
    }),
    { dispose: () => clearTimeout(timer) }
  );
  refreshAll();
  maybeAutoCollapse(vscode.window.activeTextEditor);

  // --- commands --------------------------------------------------------------
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('objdumpLens.collapseAllAsm', async () => {
    const ed = activeDisasmEditor();
    if (!ed) return;
    await setFold(foldableRuns(getModel(ed.document)).map((r) => r.start), true);
    allCollapsed.add(ed.document.uri.toString());
  });

  reg('objdumpLens.expandAllAsm', async () => {
    const ed = activeDisasmEditor();
    if (!ed) return;
    await setFold(foldableRuns(getModel(ed.document)).map((r) => r.start), false);
    allCollapsed.delete(ed.document.uri.toString());
  });

  reg('objdumpLens.toggleAllAsm', async () => {
    const ed = activeDisasmEditor();
    if (!ed) return;
    const key = ed.document.uri.toString();
    const lines = foldableRuns(getModel(ed.document)).map((r) => r.start);
    if (allCollapsed.has(key)) {
      await setFold(lines, false);
      allCollapsed.delete(key);
    } else {
      await setFold(lines, true);
      allCollapsed.add(key);
    }
  });

  reg('objdumpLens.toggleAsmAtCursor', async () => {
    const ed = activeDisasmEditor();
    if (!ed) return;
    const line = ed.selection.active.line;
    const model = getModel(ed.document);
    const runs = foldableRuns(model);
    // On an asm line (or the anchor C line): that block. On an earlier C line of
    // the same source group: the next block that follows it in the same function.
    let run = runs.find((r) => line >= r.start && line <= r.last);
    if (!run) {
      const fi = currentFunctionIndex(model, line);
      run = runs.find((r) => r.first > line && r.fn === fi);
    }
    if (!run) {
      vscode.window.showInformationMessage('ObjDump Lens: no assembly block at the cursor.');
      return;
    }
    await vscode.commands.executeCommand('editor.toggleFold', { selectionLines: [run.start], levels: 1, direction: 'down' });
  });

  const functionCommand = (fold) => async () => {
    const ed = activeDisasmEditor();
    if (!ed) return;
    const model = getModel(ed.document);
    const fi = currentFunctionIndex(model, ed.selection.active.line);
    if (fi < 0) {
      vscode.window.showInformationMessage('ObjDump Lens: the cursor is not inside a function.');
      return;
    }
    const fn = model.functions[fi];
    const lines = foldableRuns(model).filter((r) => r.start >= fn.line && r.last <= fn.end).map((r) => r.start);
    await setFold(lines, fold);
  };
  reg('objdumpLens.collapseFunctionAsm', functionCommand(true));
  reg('objdumpLens.expandFunctionAsm', functionCommand(false));
}

function deactivate() {
  const flushed = docsClient ? docsClient.flush() : undefined;
  modelCache.clear();
  allCollapsed.clear();
  autoCollapsed.clear();
  return flushed;
}

module.exports = { activate, deactivate };
