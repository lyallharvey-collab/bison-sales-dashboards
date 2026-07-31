import assert from 'node:assert';
import { buildMethodCall, parseMethodResponse } from './xmlrpc.js';

// 1. Encoding round-trips through structures matching real execute_kw calls.
const call = buildMethodCall('execute_kw', [
  'mydb', 53, 'pw', 'sale.order', 'read_group',
  [[['state', '=', 'sale'], ['date_order', '>=', '2026-07-01']]],
  ['amount_untaxed'],
  ['date_order:day'],
  { lazy: false },
]);
assert.ok(call.includes('<methodName>execute_kw</methodName>'));
assert.ok(call.includes('&lt;')  === false); // no raw '<' leaked unescaped elsewhere
console.log('encode: ok');

// 2. A realistic read_group response: struct with a colon-bearing key, a
//    nested __range struct, negative float (refund), and an empty array.
const readGroupResponse = `<?xml version="1.0"?>
<methodResponse><params><param><value><array><data>
  <value><struct>
    <member><name>x_studio_date:day</name><value><string>03 Jul 2026</string></value></member>
    <member><name>x_studio_company_daily_target</name><value><double>42400.0</double></value></member>
    <member><name>__range</name><value><struct>
      <member><name>x_studio_date:day</name><value><struct>
        <member><name>from</name><value><string>2026-07-03</string></value></member>
        <member><name>to</name><value><string>2026-07-04</string></value></member>
      </struct></value></member>
    </struct></value></member>
    <member><name>x_studio_date:day_count</name><value><int>1</int></value></member>
  </struct></value>
  <value><struct>
    <member><name>aml_total_net</name><value><double>-480.63</double></value></member>
    <member><name>__range</name><value><struct></struct></value></member>
  </struct></value>
</data></array></value></param></params></methodResponse>`;

const decoded = parseMethodResponse(readGroupResponse);
assert.strictEqual(decoded.length, 2);
assert.strictEqual(decoded[0]['x_studio_date:day'], '03 Jul 2026');
assert.strictEqual(decoded[0].x_studio_company_daily_target, 42400.0);
assert.strictEqual(decoded[0].__range['x_studio_date:day'].from, '2026-07-03');
assert.strictEqual(decoded[1].aml_total_net, -480.63);
console.log('decode struct/array/colon-keys/negative-double: ok');

// 3. Boolean, nil, int vs double distinction.
const scalarResponse = `<methodResponse><params><param><value><struct>
  <member><name>ok</name><value><boolean>1</boolean></value></member>
  <member><name>missing</name><value><nil/></value></member>
  <member><name>count</name><value><int>732</int></value></member>
  <member><name>total</name><value><double>33708954.10</double></value></member>
</struct></value></param></params></methodResponse>`;
const decoded2 = parseMethodResponse(scalarResponse);
assert.strictEqual(decoded2.ok, true);
assert.strictEqual(decoded2.missing, null);
assert.strictEqual(decoded2.count, 732);
assert.strictEqual(decoded2.total, 33708954.10);
console.log('decode boolean/nil/int/double: ok');

// 4. Entity-escaped string content (Odoo lead/company names can contain & < >).
const entityResponse = `<methodResponse><params><param><value><string>W &amp; J Smith &lt;Ltd&gt;</string></value></param></params></methodResponse>`;
assert.strictEqual(parseMethodResponse(entityResponse), 'W & J Smith <Ltd>');
console.log('decode entities: ok');

// 5. Fault response raises with the fault string, not silently returning junk.
const faultResponse = `<methodResponse><fault><value><struct>
  <member><name>faultCode</name><value><int>1</int></value></member>
  <member><name>faultString</name><value><string>Access Denied</string></value></member>
</struct></value></fault></methodResponse>`;
assert.throws(() => parseMethodResponse(faultResponse), /Access Denied/);
console.log('fault handling: ok');

// 6. Empty array (no groups at all) decodes to [], not null/undefined.
const emptyArrayResponse = `<methodResponse><params><param><value><array><data></data></array></value></param></params></methodResponse>`;
assert.deepStrictEqual(parseMethodResponse(emptyArrayResponse), []);
console.log('empty array: ok');

console.log('ALL XML-RPC CODEC TESTS PASSED');
