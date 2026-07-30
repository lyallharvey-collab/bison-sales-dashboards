/**
 * Minimal XML-RPC codec, hand-written rather than via a generic XML library.
 *
 * Cloudflare Workers have no DOMParser, and XML-RPC's grammar is small and
 * fully known in advance (no attributes, no namespaces, ~10 possible tags) —
 * a generic XML-to-object mapper's edge-case handling (empty tags, repeated
 * siblings, self-closing detection) is exactly the kind of thing that could
 * silently corrupt a financial figure. A parser scoped to this one grammar
 * is easier to reason about and verify than trusting a library's shape.
 */

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function encodeValue(v) {
  if (v === null || v === undefined) return '<value><nil/></value>';
  if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? `<value><int>${v}</int></value>`
      : `<value><double>${v}</double></value>`;
  }
  if (typeof v === 'string') return `<value><string>${escapeXml(v)}</string></value>`;
  if (Array.isArray(v)) {
    return `<value><array><data>${v.map(encodeValue).join('')}</data></array></value>`;
  }
  if (typeof v === 'object') {
    const members = Object.entries(v)
      .map(([k, val]) => `<member><name>${escapeXml(k)}</name>${encodeValue(val)}</member>`)
      .join('');
    return `<value><struct>${members}</struct></value>`;
  }
  throw new Error(`xmlrpc: cannot encode value ${JSON.stringify(v)}`);
}

export function buildMethodCall(methodName, params) {
  const paramsXml = params.map((p) => `<param>${encodeValue(p)}</param>`).join('');
  return `<?xml version="1.0"?><methodCall><methodName>${methodName}</methodName><params>${paramsXml}</params></methodCall>`;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // must be last
}

const TAG_RE = /<(\/?)([A-Za-z0-9_.]+)\s*(\/?)>/g;

/** Parse XML into {tag, children: [], text: ''} nodes. No attributes, no
 * namespaces, no CDATA — none of which XML-RPC ever produces. */
function parseXml(str) {
  str = str.replace(/^\s*<\?xml[^>]*\?>\s*/i, '');

  function readUntilTag(fromPos) {
    TAG_RE.lastIndex = fromPos;
    const m = TAG_RE.exec(str);
    return { text: str.slice(fromPos, m ? m.index : str.length), match: m };
  }

  function parseNode(fromPos) {
    const { match } = readUntilTag(fromPos);
    if (!match) throw new Error('xmlrpc: unexpected end of document');
    const [, closing, name, selfClose] = match;
    if (closing) throw new Error(`xmlrpc: unexpected closing tag </${name}>`);
    const node = { tag: name, children: [], text: '' };
    let cursor = match.index + match[0].length;
    if (selfClose) return [node, cursor];

    let sawElement = false;
    for (;;) {
      const { text: chunk, match: next } = readUntilTag(cursor);
      if (!next) throw new Error(`xmlrpc: unterminated <${name}>`);
      if (next[1]) {
        if (!sawElement) node.text += decodeEntities(chunk);
        if (next[2] !== name) {
          throw new Error(`xmlrpc: expected </${name}>, got </${next[2]}>`);
        }
        cursor = next.index + next[0].length;
        return [node, cursor];
      }
      sawElement = true;
      const [child, afterChild] = parseNode(cursor);
      node.children.push(child);
      cursor = afterChild;
    }
  }

  const [root] = parseNode(0);
  return root;
}

function findChild(node, tag) {
  return node.children.find((c) => c.tag === tag) || null;
}
function findChildren(node, tag) {
  return node.children.filter((c) => c.tag === tag);
}

function decodeValueNode(valueNode) {
  if (!valueNode) return null;
  // A <value> with no typed child and only text is an implicit <string>.
  if (valueNode.children.length === 0) return valueNode.text ?? '';
  const typed = valueNode.children[0];
  switch (typed.tag) {
    case 'string':
      return typed.text;
    case 'int':
    case 'i4':
      return parseInt(typed.text, 10);
    case 'double':
      return parseFloat(typed.text);
    case 'boolean':
      return typed.text.trim() === '1';
    case 'nil':
      return null;
    case 'dateTime.iso8601':
    case 'base64':
      return typed.text;
    case 'array': {
      const data = findChild(typed, 'data');
      const values = data ? findChildren(data, 'value') : [];
      return values.map(decodeValueNode);
    }
    case 'struct': {
      const members = findChildren(typed, 'member');
      const out = {};
      for (const m of members) {
        const nameNode = findChild(m, 'name');
        const valueNode2 = findChild(m, 'value');
        out[nameNode.text] = decodeValueNode(valueNode2);
      }
      return out;
    }
    default:
      throw new Error(`xmlrpc: unknown value type <${typed.tag}>`);
  }
}

export function parseMethodResponse(xmlText) {
  const root = parseXml(xmlText);
  const fault = findChild(root, 'fault');
  if (fault) {
    const decoded = decodeValueNode(findChild(fault, 'value'));
    const message = decoded && decoded.faultString ? decoded.faultString : JSON.stringify(decoded);
    throw new Error(`Odoo XML-RPC fault: ${message}`);
  }
  const params = findChild(root, 'params');
  const param = params ? findChild(params, 'param') : null;
  return param ? decodeValueNode(findChild(param, 'value')) : null;
}
