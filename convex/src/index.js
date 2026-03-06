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

// “Text-like”: rewrite links inside body.
const TEXT_CONTENT_TYPE_PREFIXES = [
  'text/',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/xhtml+xml',
  'image/svg+xml',
];

// “Binary/media”: do NOT rewrite body.
const BINARY_CONTENT_TYPE_PREFIXES = [
  'image/',
  'audio/',
  'video/',
  'font/',
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-gzip',
];

function normalizeContentType(ct) {
  return (ct || '').toLowerCase().split(';', 1)[0].trim();
}

function isHtml(contentType) {
  const ct = normalizeContentType(contentType);
  return ct === 'text/html' || ct === 'application/xhtml+xml';
}

function isLikelyBinary(contentType) {
  const ct = normalizeContentType(contentType);
  if (!ct) return false;
  return BINARY_CONTENT_TYPE_PREFIXES.some((p) => (p.endsWith('/') ? ct.startsWith(p) : ct === p));
}

function isTextLike(contentType) {
  const ct = normalizeContentType(contentType);
  if (!ct) return false;
  if (isLikelyBinary(ct)) return false;
  return TEXT_CONTENT_TYPE_PREFIXES.some((p) => (p.endsWith('/') ? ct.startsWith(p) : ct === p));
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
    // Important: avoid compression so we can rewrite text reliably.
    if (key === 'accept-encoding') continue;
    out.set(k, v);
  }
  if (!out.has('user-agent')) out.set('user-agent', 'convex-worker-proxy/1.0');
  return out;
}

function filterResponseHeaders(inHeaders) {
  const out = new Headers();
  for (const [k, v] of inHeaders.entries()) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    // We may change the body size; strip these.
    if (key === 'content-encoding') continue;
    if (key === 'content-length') continue;
    out.set(k, v);
  }
  return corsifyHeaders(out);
}

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

function b64urlEncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function shouldSkipRewrite(raw) {
  if (!raw) return true;
  const t = raw.trim();
  return t.startsWith('#') || /^(data:|mailto:|tel:|javascript:|about:|blob:)/i.test(t);
}

// IMPORTANT: This is the bit you asked for.
// If raw is "/image.jpg", new URL(raw, baseUrl) becomes "https://origin/image.jpg".
function toAbsoluteUrl(raw, baseUrl) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (shouldSkipRewrite(trimmed)) return null;

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function convexUrlForAbsolute(absoluteUrl, requestOrigin) {
  const base = new URL(requestOrigin);
  base.search = '';
  base.hash = '';
  base.pathname = '/';
  base.searchParams.set('url', b64urlEncodeUtf8(absoluteUrl));
  return base.toString();
}

function rewriteOneUrl(raw, baseUrl, requestOrigin) {
  const abs = toAbsoluteUrl(raw, baseUrl);
  if (!abs) return raw;
  return convexUrlForAbsolute(abs, requestOrigin);
}

function rewriteSrcset(value, baseUrl, requestOrigin) {
  if (!value) return value;
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  return parts
    .map((p) => {
      const [u, ...rest] = p.split(/\s+/);
      const nu = rewriteOneUrl(u, baseUrl, requestOrigin);
      return [nu, ...rest].join(' ');
    })
    .join(', ');
}

// Aggressive “rewrite everything” for non-HTML text bodies.
// This WILL break some JS/CSS edge-cases; that’s the tradeoff.
function rewriteAllLinksInText(text, baseUrl, requestOrigin) {
  if (!text) return text;

  // 1) absolute http(s) anywhere
  text = text.replace(/https?:\/\/[^\s"'<>\\)\]}]+/g, (m) => {
    if (shouldSkipRewrite(m)) return m;
    return convexUrlForAbsolute(m, requestOrigin);
  });

  // 2) CSS url(...)
  text = text.replace(/url\(\s*(['"]?)([^'\"]+)\1\s*\)/gi, (m, q, u) => {
    const nu = rewriteOneUrl(u, baseUrl, requestOrigin);
    if (nu === u) return m;
    const quote = q || '"';
    return `url(${quote}${nu}${quote})`;
  });

  // 3) CSS @import "..."
  text = text.replace(/@import\s+(['"])([^'\"]+)\1/gi, (m, q, u) => {
    const nu = rewriteOneUrl(u, baseUrl, requestOrigin);
    if (nu === u) return m;
    return `@import ${q}${nu}${q}`;
  });

  // 4) Root-relative /path best-effort.
  // Preceded by a delimiter to reduce false positives.
  text = text.replace(
    /(^|[\s"'(=,:;\[])(\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%\/?-]+)/g,
    (m, p1, p2) => {
      const abs = toAbsoluteUrl(p2, baseUrl); // <- prefixes upstream origin
      if (!abs) return m;
      return p1 + convexUrlForAbsolute(abs, requestOrigin);
    },
  );

  return text;
}

class AttrRewriter {
  constructor(baseUrl, requestOrigin, attrs) {
    this.baseUrl = baseUrl;
    this.requestOrigin = requestOrigin;
    this.attrs = attrs;
  }

  element(el) {
    for (const attr of this.attrs) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      const nu = rewriteOneUrl(val, this.baseUrl, this.requestOrigin);
      if (nu !== val) el.setAttribute(attr, nu);
    }
  }
}

class SrcsetRewriter {
  constructor(baseUrl, requestOrigin, attrs) {
    this.baseUrl = baseUrl;
    this.requestOrigin = requestOrigin;
    this.attrs = attrs;
  }

  element(el) {
    for (const attr of this.attrs) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      el.setAttribute(attr, rewriteSrcset(val, this.baseUrl, this.requestOrigin));
    }
  }
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

  // ?url= supports plain URL or base64/base64url
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

  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), init);
  } catch (e) {
    return new Response('Upstream fetch failed: ' + (e && e.message ? e.message : String(e)), {
      status: 502,
      headers: corsifyHeaders(new Headers()),
    });
  }

  const headers = filterResponseHeaders(upstream.headers);
  const contentType = upstream.headers.get('content-type') || '';
  const baseUrl = targetUrl.toString(); // <- has upstream origin (needed for /path absolutizing)
  const requestOrigin = reqUrl.origin;  // <- this worker origin

  // Media/binary: do NOT rewrite body.
  if (isLikelyBinary(contentType) && !isHtml(contentType)) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  // HTML: stream rewrite a broad set of attributes.
  if (isHtml(contentType)) {
    headers.set('content-type', contentType);

    const attrs = [
      'href',
      'src',
      'action',
      'poster',
      'data',
      'formaction',
      'xlink:href',
      // lazy-load / alt link attrs
      'data-src',
      'data-original',
      'data-lazy-src',
      'data-href',
    ];

    const rewriter = new HTMLRewriter()
      .on('*', new AttrRewriter(baseUrl, requestOrigin, attrs))
      .on('img', new SrcsetRewriter(baseUrl, requestOrigin, ['srcset', 'data-srcset']))
      .on('source', new SrcsetRewriter(baseUrl, requestOrigin, ['srcset', 'data-srcset']));

    return rewriter.transform(
      new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      }),
    );
  }

  // Other text: rewrite EVERYTHING in the text body.
  if (isTextLike(contentType)) {
    let text;
    try {
      text = await upstream.text();
    } catch {
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }

    const rewritten = rewriteAllLinksInText(text, baseUrl, requestOrigin);
    headers.set('content-type', contentType);

    return new Response(rewritten, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  // Unknown: pass through.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request);
  },
};