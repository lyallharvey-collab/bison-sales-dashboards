import assert from 'node:assert';
import { buildJsonRpcBody, parseJsonRpcResponse, OdooError } from './jsonrpc.js';

// 1. Request envelope matches what Odoo's /jsonrpc expects.
const body = JSON.parse(buildJsonRpcBody('object', 'execute_kw', [
  'mydb', 53, 'pw', 'sale.order', 'read_group',
  [[['state', '=', 'sale']], ['amount_untaxed'], ['date_order:day']],
  { lazy: false },
]));
assert.strictEqual(body.jsonrpc, '2.0');
assert.strictEqual(body.method, 'call');
assert.strictEqual(body.params.service, 'object');
assert.strictEqual(body.params.method, 'execute_kw');
// args = [db, uid, password, model, method, positionalArgs, kwargs]
assert.strictEqual(body.params.args[3], 'sale.order');
assert.strictEqual(body.params.args[4], 'read_group');
assert.deepStrictEqual(body.params.args[6], { lazy: false });
console.log('request envelope: ok');

// 2. A read_group result, including the __range structure the day/month
//    bucketing depends on, and a negative float (refund).
const ok = JSON.stringify({
  jsonrpc: '2.0', id: 1,
  result: [
    {
      'x_studio_date:day': '03 Jul 2026',
      x_studio_company_daily_target: 42400.0,
      __range: { 'x_studio_date:day': { from: '2026-07-03', to: '2026-07-04' } },
      __count: 1,
    },
    { aml_total_net: -480.63, __range: {} },
  ],
});
const rows = parseJsonRpcResponse(ok);
assert.strictEqual(rows.length, 2);
assert.strictEqual(rows[0].__range['x_studio_date:day'].from, '2026-07-03');
assert.strictEqual(rows[0].x_studio_company_daily_target, 42400.0);
assert.strictEqual(rows[1].aml_total_net, -480.63);
console.log('read_group result incl. __range: ok');

// 3. Falsy-but-valid results must NOT be treated as errors. A failed
//    authenticate returns result:false, and search_count can return 0.
assert.strictEqual(parseJsonRpcResponse('{"jsonrpc":"2.0","id":1,"result":false}'), false);
assert.strictEqual(parseJsonRpcResponse('{"jsonrpc":"2.0","id":1,"result":0}'), 0);
assert.deepStrictEqual(parseJsonRpcResponse('{"jsonrpc":"2.0","id":1,"result":[]}'), []);
console.log('falsy results pass through: ok');

// 4. Odoo errors arrive with HTTP 200 and an `error` key — the whole reason
//    status codes cannot be used to detect failure.
const errBody = JSON.stringify({
  jsonrpc: '2.0', id: 1,
  error: {
    code: 200,
    message: 'Odoo Server Error',
    data: { name: 'builtins.ValueError', message: "Invalid field 'nope' on model 'crm.lead'" },
  },
});
assert.throws(() => parseJsonRpcResponse(errBody), (e) =>
  e instanceof OdooError && /Invalid field 'nope'/.test(e.message) && /ValueError/.test(e.message));
console.log('error extraction: ok');

// 5. Non-JSON (proxy/WAF/login page) must fail loudly, and must not splatter
//    an entire HTML page into the message.
const html = '<!doctype html><html><body>' + 'x'.repeat(5000) + '</body></html>';
assert.throws(() => parseJsonRpcResponse(html), (e) =>
  e instanceof OdooError && e.message.length < 300 && /non-JSON/.test(e.message));
console.log('non-JSON response: ok');

// 6. A well-formed envelope with neither result nor error is still an error.
assert.throws(() => parseJsonRpcResponse('{"jsonrpc":"2.0","id":1}'), /no result/);
console.log('missing result key: ok');

console.log('ALL JSON-RPC CODEC TESTS PASSED');
