import { buildJsonRpcBody, parseJsonRpcResponse, OdooError } from './jsonrpc.js';

export { OdooError };

export class OdooClient {
  constructor({ url, db, username, password }) {
    this.url = url.replace(/\/$/, '');
    this.db = db;
    this.username = username;
    this.password = password;
    this._authPromise = null;
    // Request-scoped dedup. Building a dashboard genuinely asks for the same
    // thing more than once — e.g. the subscription-order names are needed by
    // both the daily and the monthly Orders component — and previously each
    // repeat cost another round trip and another parse. Caching the PROMISE
    // (not the result) also collapses concurrent identical calls into one,
    // which matters now the series are fetched in parallel.
    //
    // Safe because a client instance lives for exactly one request: each Pages
    // Function invocation is a fresh isolate, so this cannot serve stale data
    // across requests.
    this._inflight = new Map();
  }

  async _post(service, method, args) {
    const res = await fetch(`${this.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildJsonRpcBody(service, method, args),
    });
    // Odoo signals application errors with HTTP 200 and an `error` key, so
    // this status check only catches transport-level failures. The `error`
    // case is handled inside parseJsonRpcResponse.
    if (!res.ok) {
      throw new OdooError(`HTTP ${res.status} from Odoo (${service}.${method})`);
    }
    return parseJsonRpcResponse(await res.text());
  }

  async uid() {
    if (!(this.username && this.password)) {
      throw new OdooError('Missing ODOO_USERNAME/ODOO_PASSWORD');
    }
    // Deduped like everything else: with series fetched in parallel, several
    // callers can reach for the uid at once on a cold client.
    if (!this._authPromise) {
      this._authPromise = this._post('common', 'authenticate', [
        this.db, this.username, this.password, {},
      ]).then((uid) => {
        if (!uid) throw new OdooError('Odoo authentication failed');
        return uid;
      });
      // Don't cache a rejection — a transient failure shouldn't poison the
      // rest of the request.
      this._authPromise.catch(() => { this._authPromise = null; });
    }
    return this._authPromise;
  }

  async execute(model, method, args = [], kwargs = {}) {
    const uid = await this.uid();
    const key = JSON.stringify([model, method, args, kwargs]);
    let promise = this._inflight.get(key);
    if (!promise) {
      promise = this._post('object', 'execute_kw', [
        this.db, uid, this.password, model, method, args, kwargs,
      ]);
      this._inflight.set(key, promise);
      promise.catch(() => { this._inflight.delete(key); });
    }
    return promise;
  }

  async searchRead(model, domain = [], { fields, limit, order } = {}) {
    const kwargs = {};
    if (fields) kwargs.fields = fields;
    if (limit) kwargs.limit = limit;
    if (order) kwargs.order = order;
    return this.execute(model, 'search_read', [domain], kwargs);
  }

  async readGroup(model, domain, fields, groupby, lazy = false) {
    return this.execute(model, 'read_group', [domain, fields, groupby], { lazy });
  }

  async searchCount(model, domain = []) {
    return this.execute(model, 'search_count', [domain]);
  }
}
