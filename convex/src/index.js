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

// Best-effort ad/tracker blocking (NO ADS)
const BLOCKED_HOST_SUBSTRINGS = [
  'prebid',
  'googlesyndication',
  'doubleclick',
  'googletagmanager',
  'google-analytics',
  'adservice',
  'adsystem',
  'rubiconproject',
  'openx',
  'criteo',
  'taboola',
  'outbrain',
  'scorecardresearch',
];

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

function isBlockedHost(hostname) {
  const h = (hostname || '').toLowerCase();
  return BLOCKED_HOST_SUBSTRINGS.some((s) => h.includes(s));
}

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

// utf8 -> base64url
function b64urlEncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// base64url -> utf8
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

function shouldSkipRewrite(raw) {
  if (!raw) return true;
  const t = raw.trim();
  return t.startsWith('#') || /^(data:|mailto:|tel:|javascript:|about:|blob:)/i.test(t);
}

function isCorsEnabled(reqUrl) {
  return (reqUrl.searchParams.get('cors') || '') === '1';
}

function maybeCorsify(headers, corsEnabled) {
  if (!corsEnabled) return headers;
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
    // Avoid compression so rewriting can work.
    if (key === 'accept-encoding') continue;
    out.set(k, v);
  }
  if (!out.has('user-agent')) out.set('user-agent', 'convex-worker-proxy/1.0');
  return out;
}

function filterResponseHeaders(inHeaders, corsEnabled) {
  const out = new Headers();
  for (const [k, v] of inHeaders.entries()) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    if (key === 'content-encoding') continue;
    if (key === 'content-length') continue;
    out.set(k, v);
  }
  return maybeCorsify(out, corsEnabled);
}

function splitFromFullUrl(fullUrl) {
  const u = new URL(fullUrl);
  return { siteOrigin: u.origin, path: u.pathname + (u.search || '') };
}

function buildProxyUrlSitePath(siteOrigin, path, requestOrigin, corsEnabled) {
  const base = new URL(requestOrigin);
  base.search = '';
  base.hash = '';
  base.pathname = '/';

  base.searchParams.set('site', b64urlEncodeUtf8(siteOrigin));
  base.searchParams.set('path', b64urlEncodeUtf8(path || '/'));

  if (corsEnabled) base.searchParams.set('cors', '1');

  return base.toString();
}

// Parse new split params OR old url param (plain or base64url full URL)
function parseRequestTarget(reqUrl) {
  const siteParam = (reqUrl.searchParams.get('site') || '').trim().replace(/^"|"$/g, '');
  const pathParam = (reqUrl.searchParams.get('path') || '').trim().replace(/^"|"$/g, '');
  const urlParam = (reqUrl.searchParams.get('url') || '').trim().replace(/^"|"$/g, '');

  // New split
  if (siteParam || pathParam) {
    if (!siteParam || !pathParam) return null;

    const siteDecoded = decodeBase64UrlToString(siteParam).trim();
    const pathDecoded = decodeBase64UrlToString(pathParam).trim();

    if (!looksLikeUrl(siteDecoded)) return null;
    if (!pathDecoded.startsWith('/')) return null;

    const siteOrigin = new URL(siteDecoded).origin; // clamp to origin
    const fullUrl = new URL(pathDecoded, siteOrigin).toString();

    return { fullUrl, siteOrigin, path: pathDecoded, mode: 'split' };
  }

  // Old url
  if (!urlParam) return null;

  let decoded = urlParam;
  if (!looksLikeUrl(decoded)) {
    const maybe = decodeBase64UrlToString(decoded).trim();
    if (maybe) decoded = maybe;
  }
  if (!looksLikeUrl(decoded)) return null;

  const { siteOrigin, path } = splitFromFullUrl(decoded);
  return { fullUrl: decoded, siteOrigin, path, mode: 'url' };
}

// Rewrite discovered link to split-style (site+path base64url).
function rewriteAttrToSplit(raw, currentSiteOrigin, requestOrigin, corsEnabled) {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (shouldSkipRewrite(trimmed)) return raw;

  // Absolute
  if (looksLikeUrl(trimmed)) {
    try {
      const { siteOrigin, path } = splitFromFullUrl(trimmed);
      return buildProxyUrlSitePath(siteOrigin, path, requestOrigin, corsEnabled);
    } catch {
      return raw;
    }
  }

  // Protocol-relative //cdn.example.com/x
  if (trimmed.startsWith('//')) {
    try {
      const { siteOrigin, path } = splitFromFullUrl('https:' + trimmed);
      return buildProxyUrlSitePath(siteOrigin, path, requestOrigin, corsEnabled);
    } catch {
      return raw;
    }
  }

  // Root-relative: keep current origin
  if (trimmed.startsWith('/')) {
    return buildProxyUrlSitePath(currentSiteOrigin, trimmed, requestOrigin, corsEnabled);
  }

  // Relative: resolve against origin root
  try {
    const resolved = new URL(trimmed, currentSiteOrigin + '/').toString();
    const { siteOrigin, path } = splitFromFullUrl(resolved);
    return buildProxyUrlSitePath(siteOrigin, path, requestOrigin, corsEnabled);
  } catch {
    return raw;
  }
}

function rewriteSrcset(value, currentSiteOrigin, requestOrigin, corsEnabled) {
  if (!value) return value;
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  return parts
    .map((p) => {
      const [u, ...rest] = p.split(/\s+/);
      const nu = rewriteAttrToSplit(u, currentSiteOrigin, requestOrigin, corsEnabled);
      return [nu, ...rest].join(' ');
    })
    .join(', ');
}

// Conservative text rewriting:
// - absolute http(s) URLs anywhere
// - CSS url(...)
// - CSS @import
// NO bare /path rewriting (breaks JS).
function rewriteAllLinksInText(text, currentSiteOrigin, requestOrigin, corsEnabled) {
  if (!text) return text;

  text = text.replace(/https?:\/\/[^\s"'<>\\)\]}]+/g, (m) => {
    if (shouldSkipRewrite(m)) return m;
    try {
      const { siteOrigin, path } = splitFromFullUrl(m);
      return buildProxyUrlSitePath(siteOrigin, path, requestOrigin, corsEnabled);
    } catch {
      return m;
    }
  });

  text = text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    const nu = rewriteAttrToSplit(u, currentSiteOrigin, requestOrigin, corsEnabled);
    if (nu === u) return m;
    const quote = q || '"';
    return `url(${quote}${nu}${quote})`;
  });

  text = text.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
    const nu = rewriteAttrToSplit(u, currentSiteOrigin, requestOrigin, corsEnabled);
    if (nu === u) return m;
    return `@import ${q}${nu}${q}`;
  });

  return text;
}

class AttrRewriter {
  constructor(currentSiteOrigin, requestOrigin, corsEnabled, attrs) {
    this.currentSiteOrigin = currentSiteOrigin;
    this.requestOrigin = requestOrigin;
    this.corsEnabled = corsEnabled;
    this.attrs = attrs;
  }

  element(el) {
    for (const attr of this.attrs) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      const nu = rewriteAttrToSplit(val, this.currentSiteOrigin, this.requestOrigin, this.corsEnabled);
      if (nu !== val) el.setAttribute(attr, nu);
    }
  }
}

class SrcsetRewriter {
  constructor(currentSiteOrigin, requestOrigin, corsEnabled, attrs) {
    this.currentSiteOrigin = currentSiteOrigin;
    this.requestOrigin = requestOrigin;
    this.corsEnabled = corsEnabled;
    this.attrs = attrs;
  }

  element(el) {
    for (const attr of this.attrs) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      el.setAttribute(attr, rewriteSrcset(val, this.currentSiteOrigin, this.requestOrigin, this.corsEnabled));
    }
  }
}

async function handleRequest(request) {
  const reqUrl = new URL(request.url);
  const corsEnabled = isCorsEnabled(reqUrl);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: maybeCorsify(new Headers(), corsEnabled),
    });
  }

  const target = parseRequestTarget(reqUrl);
  if (!target) {
    return new Response(
      'Bad request. Use either:\n' +
        '- ?url=<full url (plain or base64url)>\n' +
        '- ?site=<base64url(origin)>&path=<base64url(/path)>\n' +
        '- add &cors=1 to enable CORS headers\n',
      { status: 400, headers: maybeCorsify(new Headers(), corsEnabled) },
    );
  }

  let upstreamUrl;
  try {
    upstreamUrl = new URL(target.fullUrl);
  } catch {
    return new Response('Invalid target URL', { status: 400, headers: maybeCorsify(new Headers(), corsEnabled) });
  }

  // Block ads/tracking
  if (isBlockedHost(upstreamUrl.hostname)) {
    return new Response(null, { status: 204, headers: maybeCorsify(new Headers(), corsEnabled) });
  }

  const init = {
    method: request.method,
    headers: filterRequestHeaders(request.headers),
    redirect: 'follow',
  };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;

  let upstream;
  try {
    upstream = await fetch(upstreamUrl.toString(), init);
  } catch (e) {
    return new Response('Upstream fetch failed: ' + (e && e.message ? e.message : String(e)), {
      status: 502,
      headers: maybeCorsify(new Headers(), corsEnabled),
    });
  }

  const headers = filterResponseHeaders(upstream.headers, corsEnabled);
  const contentType = upstream.headers.get('content-type') || '';

  const currentSiteOrigin = upstreamUrl.origin;
  const requestOrigin = reqUrl.origin;

  // binary/media passthrough
  if (isLikelyBinary(contentType) && !isHtml(contentType)) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  // HTML rewrite
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
      'data-src',
      'data-original',
      'data-lazy-src',
      'data-href',
    ];

    const rewriter = new HTMLRewriter()
      .on('*', new AttrRewriter(currentSiteOrigin, requestOrigin, corsEnabled, attrs))
      .on('img', new SrcsetRewriter(currentSiteOrigin, requestOrigin, corsEnabled, ['srcset', 'data-srcset']))
      .on('source', new SrcsetRewriter(currentSiteOrigin, requestOrigin, corsEnabled, ['srcset', 'data-srcset']));

    return rewriter.transform(
      new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      }),
    );
  }

  // other text rewrite (safe-ish)
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

    const rewritten = rewriteAllLinksInText(text, currentSiteOrigin, requestOrigin, corsEnabled);
    headers.set('content-type', contentType);

    return new Response(rewritten, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  // unknown passthrough
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
