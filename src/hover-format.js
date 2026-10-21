'use strict';
/** Turns a Compiler Explorer opcode-doc response into hover Markdown (no vscode dependency). */

const CODE = '\uE000';

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

const escapeMd = (s) => s.replace(/([\\`*_{}\[\]<>#|])/g, '\\$1');

/** CE docs html -> markdown (paragraphs, lists, <code>); every other tag (e.g. <xref>) is dropped. */
function htmlToMarkdown(html) {
  let s = String(html || '')
    .replace(/<\s*(code|samp|kbd|tt)[^>]*>/gi, CODE)
    .replace(/<\/\s*(code|samp|kbd|tt)\s*>/gi, CODE)
    .replace(/<\/p\s*>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|ul|ol|table|tr|div|h\d)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // escape markdown only outside code spans
  s = s
    .split(new RegExp(`(${CODE}[^${CODE}]*${CODE})`))
    .map((part) =>
      part.startsWith(CODE) && part.endsWith(CODE) && part.length >= 2
        ? '`' + part.slice(1, -1).replace(/`/g, "'") + '`'
        : escapeMd(part.split(CODE).join(''))
    )
    .join('');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const safeHttpUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) && !/[\s)]/.test(u) ? u : null);

/**
 * @param {{arch:string, mnemonic:string, matched:string, data:{tooltip?:string, html?:string, url?:string}, maxLen?:number}} o
 */
function buildHoverMarkdown({ arch, mnemonic, matched, data, maxLen = 1800 }) {
  let body = data.html ? htmlToMarkdown(data.html) : '';
  if (!body && data.tooltip) body = escapeMd(data.tooltip);
  if (body.length > maxLen) body = body.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';

  const title = '**' + escapeMd(matched.toUpperCase()) + '** · `' + arch + '`';
  const note = matched.toLowerCase() !== mnemonic.toLowerCase()
    ? '\n\n_`' + mnemonic + '` → `' + matched + '`_'
    : '';
  const link = safeHttpUrl(data.url) ? '\n\n[Reference](' + data.url + ')' : '';
  return `${title}${note}\n\n${body || '_(no description)_'}${link}\n\n_Source: Compiler Explorer_`;
}

module.exports = { htmlToMarkdown, buildHoverMarkdown, decodeEntities };
