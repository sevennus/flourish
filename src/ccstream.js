/*
 * ccstream.js — translate Claude Code's `--output-format stream-json` events
 * into the small set of app events the renderer already understands.
 *
 * Pure and dependency-free (UMD) so it runs in the main process and under
 * `node --test` against real captured output. Claude Code wraps raw Anthropic
 * API stream events in `{type:"stream_event", event:{...}}`; assistant text
 * arrives as incremental `text_delta`s, and session_id / cost land on the final
 * `result` event.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CCStream = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Translate one parsed stream-json object into zero or more app events:
  //   { t: 'session', id, model }
  //   { t: 'text',    value }
  //   { t: 'tool-start', name, id, index }
  //   { t: 'block-stop', index }
  //   { t: 'done',    sessionId, cost, isError, result }
  //   { t: 'notice',  kind }        (rate limits, api retries — informational)
  function translate(obj) {
    if (!obj || typeof obj !== 'object') return [];

    if (obj.type === 'system') {
      if (obj.subtype === 'init') {
        return [{ t: 'session', id: obj.session_id, model: obj.model }];
      }
      return [{ t: 'notice', kind: obj.subtype || 'system' }];
    }

    if (obj.type === 'stream_event') {
      const e = obj.event || {};
      if (e.type === 'content_block_start') {
        const cb = e.content_block || {};
        if (cb.type === 'tool_use') {
          return [{ t: 'tool-start', name: cb.name, id: cb.id, index: e.index }];
        }
        return [];
      }
      if (e.type === 'content_block_delta') {
        const d = e.delta || {};
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          return [{ t: 'text', value: d.text }];
        }
        return [];
      }
      if (e.type === 'content_block_stop') {
        return [{ t: 'block-stop', index: e.index }];
      }
      return [];
    }

    if (obj.type === 'result') {
      return [{
        t: 'done',
        sessionId: obj.session_id,
        cost: obj.total_cost_usd,
        isError: !!obj.is_error,
        result: obj.result,
      }];
    }

    if (obj.type === 'rate_limit_event') return [{ t: 'notice', kind: 'rate_limit' }];

    // 'assistant' (full-message duplicate), 'message_delta', 'user', etc. → ignore
    return [];
  }

  /*
   * LineBuffer — accumulate stdout chunks and hand back complete parsed JSON
   * objects. stream-json is newline-delimited; a chunk may split a line.
   */
  class LineBuffer {
    constructor() { this.buf = ''; }
    push(chunk) {
      this.buf += chunk;
      const out = [];
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip non-JSON noise */ }
      }
      return out;
    }
    flush() {
      const line = this.buf.trim();
      this.buf = '';
      if (!line) return [];
      try { return [JSON.parse(line)]; } catch { return []; }
    }
  }

  return { translate, LineBuffer };
});
