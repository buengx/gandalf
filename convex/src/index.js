'use strict';

/**
 * Cloudflare Workers runtime:
 * - No Node.js built-ins unless you enable nodejs_compat.
 * - decodeURIComponent is global; don't require('url').
 */

/**
 * Decode a base64/base64url-encoded string into a UTF-8 string.
 * Accepts standard base64 (+/) and base64url (-_). Adds padding if missing.
 */
function decodeBase64UrlToString(input) {
  if (!input) return '';

  // URLSearchParams already percent-decodes values, but handle any remaining encoding safely.
  let s;
  try {
    s = decodeURIComponent(input);
  } catch {
    s = input;
  }

  // Normalize base64url -> base64
  s = s.replace(/-/g, '+').replace(/_/g, '/');

  // Fix padding
  const pad = s.length % 4;
  if (pad === 2) s += '==' ;
  else if (pad === 3) s += '=';
  else if (pad !== 0) {
    // Invalid base64 length
    return '';
  }

  try {
    // atob returns a binary string; convert to Uint8Array then decode UTF-8
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export default async function fetchHandler(request) {
  const { searchParams } = new URL(request.url);

  // Support either:
  // - ?url=<normal URL>
  // - ?url_b64=<base64/base64url of URL>
  const rawUrl = (searchParams.get('url') || '').trim().replace(/^"|"$/g, '');
  const rawUrlB64 = (searchParams.get('url_b64') || '').trim().replace(/^"|"$/g, '');

  let targetUrl = rawUrl;
  if (!targetUrl && rawUrlB64) {
    targetUrl = decodeBase64UrlToString(rawUrlB64).trim().replace(/^"|"$/g, '');
  }

  if (!targetUrl) {
    return new Response('Missing url parameter (use ?url=... or ?url_b64=...)', { status: 400 });
  }

  // Minimal validation
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return new Response('Invalid url parameter', { status: 400 });
  }

  // TODO: your actual fetch/proxy logic goes here.
  return new Response(`OK: ${parsed.toString()}`);
}