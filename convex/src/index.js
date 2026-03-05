'use strict';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

const ALWAYS_TEXT_TYPES = [
  'text/',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'image/svg+xml',
];

function decodeBase64UrlToString(input) {
  if (!input) return '';

  let s;
  try {
    s = decodeURIComponent(input);
  } catch {
    s = input;
  }

  // base64url -> base64
  s = s.replace(/-/g, '+').replace(/_/g, '/');

  // padding
  const pad = s.length % 4;
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';
  else if (pad !== 0) return '';

  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

function looksLikeUrl(s) {
  return /^https?:\/\//i.test(s);
}

function corsifyHeaders(headers) {
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  headers.set('access-control-allow-headers', '*');
  headers.set('access-control-max-age', '86400');
  return headers;
}

function filterRequestHeaders(inHeaders) {
  const out = new Headers();
  for (const [k, v] of inHeaders.entries()) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    if (key.startsWith('cf-')) continue;
    if (key === 'accept-encoding') continue;
    out.set(k, v);
  }

  if (!out.has('user-agent')) {
    out.set('user-agent', 'convex-worker-proxy/1.0');
  }

  return out;
}

function filterResponseHeaders(inHeaders) {
  const out = new Headers();
  for (const [k, v] of inHeaders.entries()) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    if (key === 'content-encoding') continue;
    if (key === 'content-length') continue;
    out.set(k, v);
  }
  return out;
}

function isTextLikeContentType(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase().split(';', 1)[0].trim();
  return ALWAYS_TEXT_TYPES.some((p) => (p.endsWith('/') ? ct.startsWith(p) : ct === p));
}

function b64urlEncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function convexUrlFor(targetUrl, requestOrigin) {
  // Force same worker origin so everything stays on convex.
  const base = new URL(requestOrigin);
  base.search = '';
  base.hash = '';
  base.pathname = '/';
  base.searchParams.set('url', b64urlEncodeUtf8(targetUrl));
  return base.toString();
}

function absolutizeAndConvexify(raw, baseUrl, requestOrigin) {
  if (!raw) return raw;
  const trimmed = raw.trim();

  // Ignore non-navigational/unsupported schemes.
  if (/^(data:|mailto:|tel:|javascript:|about:|blob:)/i.test(trimmed)) return raw;

  // Keep fragments as-is (but still point through convex). Most browsers expect same-document anchors.
  if (trimmed.startsWith('#')) return raw;

  let absolute;
  try {
    absolute = new URL(trimmed, baseUrl).toString();
  } catch {
    return raw;
  }

  return convexUrlFor(absolute, requestOrigin);
}

function rewriteCss(text, baseUrl, requestOrigin) {
  // url(...) patterns
  text = text.replace(/url\(\s*(['"]?)([^'\)]+)\1\s*\)/gi, (m, q, u) => {
    const nu = absolutizeAndConvexify(u, baseUrl, requestOrigin);
    if (nu === u) return m;
    const quote = q || '"';
    return `url(${quote}${nu}${quote})`;
  });

  // @import '...'
  text = text.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
    const nu = absolutizeAndConvexify(u, baseUrl, requestOrigin);
    if (nu === u) return m;
    return `@import ${q}${nu}${q}`;
  });

  return text;
}

function rewriteHtml(text, baseUrl, requestOrigin) {
  // Extremely naive attribute rewriting; good enough for simple pages.
  // href/src/action/poster
  text = text.replace(/\s(href|src|action|poster)=(['"])([^'\"]+)\2/gi, (m, attr, q, u) => {
    const nu = absolutizeAndConvexify(u, baseUrl, requestOrigin);
    if (nu === u) return m;
    return ` ${attr}=${q}${nu}${q}`;
  });

  // srcset="url 1x, url 2x"
  text = text.replace(/\ssrcset=(['"])([^'\"]+)\1/gi, (m, q, val) => {
    const parts = val.split(',').map((p) => p.trim()).filter(Boolean);
    const rewritten = parts.map((p) => {
      const [u, ...rest] = p.split(/\s+/);
      const nu = absolutizeAndConvexify(u, baseUrl, requestOrigin);
      return [nu, ...rest].join(' ');
    }).join(', ');
    return ` srcset=${q}${rewritten}${q}`;
  });

  return text;
}

async function handleRequest(request) {
  const reqUrl = new URL(request.url);

  // Preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsifyHeaders(new Headers()) });
  }

  const raw = (reqUrl.searchParams.get('url') || '').trim().replace(/^"|"$/g, '');
  if (!raw) {
    return new Response('Missing url parameter', { status: 400, headers: corsifyHeaders(new Headers()) });
  }

  // ?url= can be plain URL or base64/base64url
  let target = raw;
  if (!looksLikeUrl(target)) {
    const decoded = decodeBase64UrlToString(target).trim().replace(/^"|"$/g, '');
    if (decoded) target = decoded;
  }

  if (!looksLikeUrl(target)) {
    return new Response('Invalid url parameter', { status: 400, headers: corsifyHeaders(new Headers()) });
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response('Invalid url parameter', { status: 400, headers: corsifyHeaders(new Headers()) });
  }

  const init = {
    method: request.method,
    headers: filterRequestHeaders(request.headers),
    redirect: 'follow',
  };

  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body;
  }

  let resp;
  try {
    resp = await fetch(targetUrl.toString(), init);
  } catch (e) {
    return new Response('Upstream fetch failed: ' + (e && e.message ? e.message : String(e)), {
      status: 502,
      headers: corsifyHeaders(new Headers()),
    });
  }

  const contentType = resp.headers.get('content-type') || '';
  const status = resp.status;

  // For binary content, just stream through.
  if (!isTextLikeContentType(contentType)) {
    const headers = corsifyHeaders(filterResponseHeaders(resp.headers));
    return new Response(resp.body, { status, statusText: resp.statusText, headers });
  }

  // Text content: rewrite links.
  let text;
  try {
    text = await resp.text();
  } catch (e) {
    const headers = corsifyHeaders(filterResponseHeaders(resp.headers));
    return new Response(resp.body, { status, statusText: resp.statusText, headers });
  }

  const requestOrigin = reqUrl.origin;
  const baseUrl = targetUrl.toString();
  const ct = contentType.toLowerCase();

  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) {
    text = rewriteHtml(text, baseUrl, requestOrigin);
  } else if (ct.includes('text/css')) {
    text = rewriteCss(text, baseUrl, requestOrigin);
  } else if (ct.includes('application/javascript') || ct.includes('text/javascript') || ct.includes('application/x-javascript')) {
    // JS rewriting is hard; leave as-is.
  } else if (ct.includes('image/svg+xml')) {
    // SVG can contain href/xlink:href, but we keep it simple.
  }

  const headers = corsifyHeaders(filterResponseHeaders(resp.headers));
  headers.set('content-type', contentType);

  return new Response(text, { status, statusText: resp.statusText, headers });
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request);
  },
};
