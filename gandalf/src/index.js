const SELF_URL = 'https://gandalf.buengx.workers.dev';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const b64Param = url.searchParams.get("url");
      const userPass = url.searchParams.get("pw");
      const SECRET_SALT = env.GATEKEEPER_SECRET || "mylifeisalie";

      // Sub-resource / navigation requests: url param present but no pw
      if (b64Param && !userPass) {
        return await proxyRequest(b64Param, request);
      }

      // --- TIME KEY CALCULATION ---
      const aest = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Australia/Sydney',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hour12: false
      }).format(new Date());
      const [date, hour] = aest.split(', ');
      const [d, m, y] = date.split('/');
      const timeKey = `${y}-${m}-${d}T${hour}`;

      // --- AUTH CHECK ---
      const dailyPassword = await generateCode(timeKey + SECRET_SALT);

      if (!userPass || userPass !== dailyPassword) {
        return new Response("Forbidden", { status: 403 });
      }

      // --- PROXY ---
      if (b64Param) {
        return await proxyRequest(b64Param, request);
      }

      // Catch-all: reconstruct target URL from path + query (minus pw)
      const queryWithoutPw = url.search.replace(/[?&]pw=[^&]*/g, '').replace(/^&/, '?');
      const reconstructedUrl = `https://www.google.com${url.pathname}${queryWithoutPw}`;
      const b64 = btoa(reconstructedUrl).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return await proxyRequest(b64, request);

    } catch (globalError) {
      return new Response("CRITICAL EXCEPTION: " + globalError.stack, { status: 500 });
    }
  }
};

async function proxyRequest(encodedUrl, request) {
  // Normalise padding for standard or URL-safe base64
  const padded = encodedUrl + '='.repeat((4 - encodedUrl.length % 4) % 4);
  const decodedUrl = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));

  const response = await fetch(decodedUrl, {
    method: request.method,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "Accept": request.headers.get("Accept") || "*/*",
      "Accept-Language": request.headers.get("Accept-Language") || "en-US,en;q=0.9",
      "Cookie": request.headers.get("Cookie"),
      "Referer": decodedUrl
    },
    body: (request.method === "POST" || request.method === "PUT") ? request.body : null,
    redirect: "follow"
  });

  const contentType = response.headers.get("Content-Type") || "";

  if (contentType.includes("text/html")) {
    const text = await response.text();
    const modifiedText = rewriteUrls(text, decodedUrl);

    const newHeaders = new Headers(response.headers);
    newHeaders.set("Access-Control-Allow-Origin", "*");
    newHeaders.delete("Content-Security-Policy");
    newHeaders.delete("X-Frame-Options");
    newHeaders.delete("Content-Length");

    return new Response(modifiedText, { status: response.status, headers: newHeaders });
  }

  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, { status: response.status, headers: newHeaders });
}

function rewriteUrls(html, baseUrl) {
  // Rewrite URLs inside HTML attribute values (src, href, action)
  html = html.replace(/((?:src|href|action)\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix, urlVal, suffix) => {
    try {
      if (/^(javascript:|data:|mailto:|#)/.test(urlVal)) return match;
      const absolute = new URL(urlVal, baseUrl).href;
      if (absolute === SELF_URL || absolute.startsWith(SELF_URL + '/')) return match;
      const b64 = btoa(absolute).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return `${prefix}${SELF_URL}/?url=${b64}${suffix}`;
    } catch (e) {
      return match;
    }
  });

  // Rewrite remaining absolute URLs in inline text / CSS
  html = html.replace(/https?:\/\/[^\s'"<>)]+/g, (match) => {
    try {
      if (match === SELF_URL || match.startsWith(SELF_URL + '/')) return match;
      const b64 = btoa(match).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return `${SELF_URL}/?url=${b64}`;
    } catch (e) {
      return match;
    }
  });

  return html;
}

async function generateCode(message) {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("").substring(0, 8);
}