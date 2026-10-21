'use strict';
/**
 * Client for Compiler Explorer's  GET /api/asm/<instructionSet>/<opcode>.
 *
 * Caching: every distinct URL is requested at most once per TTL.
 *   - 200  -> "hit"  (cached 30 days, persisted)
 *   - 404  -> "miss" (cached 1 day, persisted; CE has no docs for that opcode/arch)
 *   - anything else (network error, 429, 5xx, bad JSON) -> "error": cached in memory for
 *     60 s only (so hovering repeatedly does not hammer a failing server) and never persisted.
 * Concurrent lookups of the same URL share one in-flight request.
 */
const http = require('http');
const https = require('https');

const DAY = 24 * 60 * 60 * 1000;
const MAX_FIELD = 6000; // keep persisted entries small

function defaultRequest(urlStr, { headers, timeoutMs }, redirects = 3) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('unsupported protocol ' + u.protocol));
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(defaultRequest(new URL(res.headers.location, u).toString(), { headers, timeoutMs }, redirects - 1));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 1e6) req.destroy(new Error('response too large'));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

class DocsClient {
  /**
   * @param {object} o
   * @param {() => string} o.getBaseUrl   e.g. () => 'https://godbolt.org'
   * @param {{get: () => object, set: (v: object) => any}} [o.store]  persistent storage (single JSON object)
   * @param {Function} [o.request]        (url, {headers, timeoutMs}) => Promise<{status, body}>
   * @param {() => number} [o.now]
   */
  constructor(o) {
    this.getBaseUrl = o.getBaseUrl;
    this.store = o.store || null;
    this.request = o.request || defaultRequest;
    this.now = o.now || Date.now;
    this.timeoutMs = o.timeoutMs || 8000;
    this.ttl = { hit: o.hitTtlMs || 30 * DAY, miss: o.missTtlMs || 1 * DAY, error: o.errorTtlMs || 60 * 1000 };
    this.maxEntries = o.maxEntries || 2000;
    this.mem = new Map();        // url -> entry
    this.inflight = new Map();   // url -> Promise<entry>
    this.persisted = this.store ? { ...(this.store.get() || {}) } : {};
    this.flushTimer = null;
    this.stats = { requests: 0, cacheHits: 0 };
  }

  urlFor(arch, opcode) {
    const base = String(this.getBaseUrl() || '').trim().replace(/\/+$/, '');
    return `${base}/api/asm/${encodeURIComponent(arch)}/${encodeURIComponent(opcode)}`;
  }

  _fresh(e) {
    return e && this.now() - e.t < this.ttl[e.kind] ? e : null;
  }

  _toResult(url, e, fromCache) {
    return { status: e.kind, url, data: e.data, message: e.message, fromCache };
  }

  /** @returns {Promise<{status:'hit'|'miss'|'error', url:string, data?:object, message?:string, fromCache:boolean}>} */
  async get(url) {
    let e = this._fresh(this.mem.get(url)) || this._fresh(this.persisted[url]);
    if (e) {
      this.mem.set(url, e);
      this.stats.cacheHits++;
      return this._toResult(url, e, true);
    }
    let p = this.inflight.get(url);
    if (!p) {
      p = this._fetch(url).finally(() => this.inflight.delete(url));
      this.inflight.set(url, p);
    }
    e = await p;
    return this._toResult(url, e, false);
  }

  async _fetch(url) {
    this.stats.requests++;
    let entry;
    try {
      const res = await this.request(url, { headers: { Accept: 'application/json', 'User-Agent': 'vscode-disasm-lens' }, timeoutMs: this.timeoutMs });
      if (res.status === 200) {
        entry = { t: this.now(), kind: 'hit', data: this._parseBody(res.body) };
      } else if (res.status === 404) {
        entry = { t: this.now(), kind: 'miss' };
      } else {
        entry = { t: this.now(), kind: 'error', message: `HTTP ${res.status}` };
      }
    } catch (err) {
      entry = { t: this.now(), kind: 'error', message: err && err.message ? err.message : String(err) };
    }
    this.mem.set(url, entry);
    if (entry.kind !== 'error') {
      this.persisted[url] = entry;
      this._schedulePersist();
    }
    return entry;
  }

  _parseBody(body) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      // server ignored Accept: application/json -> plain-text mode returns only the HTML documentation
      data = { html: body };
    }
    if (!data || typeof data !== 'object') data = { html: String(body) };
    const cut = (s) => (typeof s === 'string' ? s.slice(0, MAX_FIELD) : undefined);
    return { tooltip: cut(data.tooltip), html: cut(data.html), url: typeof data.url === 'string' ? data.url : undefined };
  }

  /** One lookup: GET /api/asm/<arch>/<opcode> */
  lookup(arch, opcode) {
    return this.get(this.urlFor(arch, opcode));
  }

  /**
   * Try candidate opcodes in order; returns the first hit. Stops early on a transport error
   * (no point burning through candidates when the server is unreachable).
   */
  async lookupFirst(arch, candidates) {
    const tried = [];
    for (const opcode of candidates) {
      const r = await this.lookup(arch, opcode);
      tried.push(opcode);
      if (r.status === 'hit') return { ...r, opcode, tried };
      if (r.status === 'error') return { ...r, opcode, tried };
    }
    return { status: 'miss', tried, fromCache: true };
  }

  _schedulePersist() {
    if (!this.store || this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 2000);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /** Write the persistent cache now (also called on deactivate). */
  async flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.store) return;
    const keys = Object.keys(this.persisted);
    if (keys.length > this.maxEntries) {
      keys.sort((a, b) => this.persisted[a].t - this.persisted[b].t);
      for (const k of keys.slice(0, keys.length - Math.floor(this.maxEntries * 0.9))) delete this.persisted[k];
    }
    await this.store.set(this.persisted);
  }

  async clear() {
    this.mem.clear();
    this.persisted = {};
    await this.flush();
  }

  get size() { return Object.keys(this.persisted).length; }
}

module.exports = { DocsClient, defaultRequest };
