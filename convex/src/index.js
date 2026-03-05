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

function filterRequestHeaders(inHeaders) {
  const out = new Headers();
  for (const [k, v] of inHeaders.entries()) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    // Don't forward CF-specific or encoding negotiation that can cause weirdness.
    if (key.startsWith('cf-')) continue;
    if (key === 'accept-encoding') continue;
    out.set(k, v);
  }

  // Set a predictable UA (some origins reject empty/worker UA).
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
    // Let Cloudflare handle these.
    if (key === 'content-encoding') continue;
    if (key === 'content-length') continue;
    out.set(k, v);
  }
  return corsifyHeaders(out);
}

async function handleRequest(request) {
  const url = new URL(request.url);

  // Preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsifyHeaders(new Headers()) });
  }

  const raw = (url.searchParams.get('url') || '').trim().replace(/^"|"$/g, '');
  if (!raw) {
    return new Response('Missing url parameter', { status: 400, headers: corsifyHeaders(new Headers()) });
  }

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

  // Only attach body for methods that can have one.
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

  const headers = filterResponseHeaders(resp.headers);

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request);
  },
};
