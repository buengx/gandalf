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

function forceConnectionClose(headers) {
  headers.set('connection', 'close');
  headers.set('keep-alive', 'timeout=0, max=0');
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

  if (!out.has('user-agent')) out.set('user-agent', 'convex-worker-proxy/1.0');

  // Best-effort upstream close for HTTP/1.1
  out.set('connection', 'close');

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

function b64urlEncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function convexUrlFor(targetUrl, requestOrigin) {
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

  if (/^(data:|mailto:|tel:|javascript:|about:|blob:)/i.test(trimmed)) return raw;
  if (trimmed.startsWith('#')) return raw;

  let absolute;
  try {
    // Resolves /file => https://origin/file
    absolute = new URL(trimmed, baseUrl).toString();
  } catch {
    return raw;
  }

  return convexUrlFor(absolute, requestOrigin);
}

function isHtml(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml+xml');
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
      const nu = absolutizeAndConvexify(val, this.baseUrl, this.requestOrigin);
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

      const parts = val.split(',').map((p) => p.trim()).filter(Boolean);
      const rewritten = parts.map((p) => {
        const [u, ...rest] = p.split(/\s+/);
        const nu = absolutizeAndConvexify(u, this.baseUrl, this.requestOrigin);
        return [nu, ...rest].join(' ');
      }).join(', ');

      el.setAttribute(attr, rewritten);
    }
  }
}

async function handleRequest(request) {
  const reqUrl = new URL(request.url);

  if (request.method === 'OPTIONS') {
    const h = forceConnectionClose(corsifyHeaders(new Headers()));
    return new Response(null, { status: 204, headers: h });
  }

  const raw = (reqUrl.searchParams.get('url') || '').trim().replace(/^"|"$/g, '');
  if (!raw) {
    const h = forceConnectionClose(corsifyHeaders(new Headers()));
    return new Response('Missing url parameter', { status: 400, headers: h });
  }

  // allow plain URL or base64/base64url in ?url=
  let target = raw;
  if (!looksLikeUrl(target)) {
    const decoded = decodeBase64UrlToString(target).trim().replace(/^"|"$/g, '');
    if (decoded) target = decoded;
  }

  if (!looksLikeUrl(target)) {
    const h = forceConnectionClose(corsifyHeaders(new Headers()));
    return new Response('Invalid url parameter', { status: 400, headers: h });
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    const h = forceConnectionClose(corsifyHeaders(new Headers()));
    return new Response('Invalid url parameter', { status: 400, headers: h });
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
    const h = forceConnectionClose(corsifyHeaders(new Headers()));
    return new Response('Upstream fetch failed: ' + (e && e.message ? e.message : String(e)), {
      status: 502,
      headers: h,
    });
  }

  const headers = forceConnectionClose(corsifyHeaders(filterResponseHeaders(upstream.headers)));
  const contentType = upstream.headers.get('content-type') || '';

  if (isHtml(contentType)) {
    headers.set('content-type', contentType);

    const requestOrigin = reqUrl.origin;
    const baseUrl = targetUrl.toString();

    const rewriter = new HTMLRewriter()
      .on('a', new AttrRewriter(baseUrl, requestOrigin, ['href']))
      .on('form', new AttrRewriter(baseUrl, requestOrigin, ['action']))
      .on('img', new AttrRewriter(baseUrl, requestOrigin, ['src', 'data-src', 'data-original', 'data-lazy-src']))
      .on('img', new SrcsetRewriter(baseUrl, requestOrigin, ['srcset', 'data-srcset']))
      .on('script', new AttrRewriter(baseUrl, requestOrigin, ['src']))
      .on('link', new AttrRewriter(baseUrl, requestOrigin, ['href']))
      .on('video', new AttrRewriter(baseUrl, requestOrigin, ['src', 'poster']))
      .on('audio', new AttrRewriter(baseUrl, requestOrigin, ['src']))
      // IMPORTANT for mp4 inside <video><source src=...>
      .on('source', new AttrRewriter(baseUrl, requestOrigin, ['src']))
      .on('source', new SrcsetRewriter(baseUrl, requestOrigin, ['srcset', 'data-srcset']));

    return rewriter.transform(new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    }));
  }

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
