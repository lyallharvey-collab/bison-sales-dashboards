import { buildMethodCall, parseMethodResponse } from './xmlrpc.js';

export class OdooError extends Error {}

export class OdooClient {
  constructor({ url, db, username, password }) {
    this.url = url.replace(/\/$/, '');
    this.db = db;
    this.username = username;
    this.password = password;
    this._uid = null;
  }

  async _call(endpoint, methodName, params) {
    const body = buildMethodCall(methodName, params);
    const res = await fetch(`${this.url}/xmlrpc/2/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body,
    });
    if (!res.ok) throw new OdooError(`HTTP ${res.status} from Odoo (${endpoint}/${methodName})`);
    return parseMethodResponse(await res.text());
  }

  async uid() {
    if (this._uid == null) {
      if (!(this.username && this.password)) {
        throw new OdooError('Missing ODOO_USERNAME/ODOO_PASSWORD');
      }
      const uid = await this._call('common', 'authenticate', [this.db, this.username, this.password, {}]);
      if (!uid) throw new OdooError('Odoo authentication failed');
      this._uid = uid;
    }
    return this._uid;
  }

  async execute(model, method, args = [], kwargs = {}) {
    const uid = await this.uid();
    return this._call('object', 'execute_kw', [this.db, uid, this.password, model, method, args, kwargs]);
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
