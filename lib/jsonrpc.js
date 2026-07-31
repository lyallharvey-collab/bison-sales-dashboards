/**
 * Odoo JSON-RPC codec.
 *
 * Replaces a hand-rolled XML-RPC parser. The reason is CPU, not taste: parsing
 * XML-RPC in JavaScript was measured at ~11ms per dashboard request, which on
 * its own exceeded Cloudflare's 10ms-per-invocation free-tier budget and was
 * killing the data feed (`outcome: "exceededCpu"`). Odoo's /jsonrpc endpoint
 * returns the same data 4-6x smaller, and native JSON.parse handles it roughly
 * 35x faster. Verified identical results on read_group (including the __range
 * structures the day/month bucketing relies on), search_read and search_count.
 *
 * These two functions are pure so they can be unit-tested without a network.
 */

export class OdooError extends Error {}

export function buildJsonRpcBody(service, method, args, id = 1) {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'call',
    id,
    params: { service, method, args },
  });
}

/**
 * Unwrap a JSON-RPC envelope.
 *
 * Note the trap this replaces: XML-RPC signalled failure with a <fault> body,
 * and JSON-RPC signals it with an `error` key — in both cases the HTTP status
 * is still 200. So callers must never treat 200 as success; that check lives
 * here rather than being left to each call site.
 */
export function parseJsonRpcResponse(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A proxy, login page or WAF interstitial rather than Odoo. Truncate so a
    // whole HTML error page can't end up in a log line.
    throw new OdooError(`Odoo returned a non-JSON response: ${String(text).slice(0, 200)}`);
  }

  if (parsed && parsed.error) {
    const data = parsed.error.data || {};
    // data.message is the human-readable Odoo message ("Invalid field ... on
    // model ..."); error.message is usually the generic "Odoo Server Error".
    const message = data.message || parsed.error.message || 'unknown error';
    const name = data.name ? ` (${data.name})` : '';
    throw new OdooError(`Odoo JSON-RPC error${name}: ${message}`);
  }

  // `result` is legitimately false/0/null for some calls (a failed
  // authenticate returns false), so only a missing key is an error.
  if (!parsed || !('result' in parsed)) {
    throw new OdooError('Odoo JSON-RPC response had no result');
  }
  return parsed.result;
}
