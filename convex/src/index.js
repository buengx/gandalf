export default {
  async fetch(request, env, ctx) {
    const workerUrl = new URL(request.url);
    const encodedUrl = workerUrl.searchParams.get('url');

    // Default to Google if no URL is provided
    if (!encodedUrl) {
      const defaultB64 = btoa("https://www.google.com/").replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return Response.redirect(`https://convex.buengx.workers.dev/?url=${defaultB64}`, 302);
    }

    try {
      // Restore stripped base64 padding before decoding
      const padded = encodedUrl + '='.repeat((4 - encodedUrl.length % 4) % 4);
      const decodedUrl = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));

      // Forward all original browser headers, stripping only Worker/infra-specific ones.
      // This preserves the real browser fingerprint (sec-fetch-*, sec-ch-ua, Accept-Encoding,
      // Upgrade-Insecure-Requests, etc.) which prevents sites from blocking us as a bot.
      const skipHeaders = new Set([
        'host', 'connection', 'transfer-encoding', 'keep-alive',
        'cf-ray', 'cf-connecting-ip', 'cf-ipcountry', 'cf-visitor', 'cf-worker',
        'cf-cache-status', 'x-forwarded-for', 'x-forwarded-proto',
        'x-real-ip', 'cdn-loop'
      ]);
      const fwdHeaders = {};
      for (const [k, v] of request.headers.entries()) {
        if (!skipHeaders.has(k.toLowerCase())) fwdHeaders[k] = v;
      }
      fwdHeaders['Referer'] = decodedUrl;

      // Fetch the target
      const response = await fetch(decodedUrl, {
        method: request.method,
        headers: fwdHeaders,
        body: (request.method === "POST" || request.method === "PUT") ? request.body : null,
        redirect: "follow"
      });

      const contentType = response.headers.get("Content-Type") || "";

      // Handle HTML - rewrite URLs to point to Convex (NOT Gandalf)
      if (contentType.includes("text/html")) {
        let text = await response.text();

        // Pass 1: rewrite URLs inside quoted HTML attributes (src, href, action)
        text = text.replace(/((?:src|href|action)\s*=\s*["'])([^"']+)(["'])/gi, (match, prefix, urlVal, suffix) => {
          try {
            if (/^(javascript:|data:|mailto:|#)/.test(urlVal)) return match;
            if (urlVal.includes("convex.buengx.workers.dev")) return match;
            const absolute = new URL(urlVal, decodedUrl).href;
            const b64 = btoa(absolute).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            return `${prefix}https://convex.buengx.workers.dev/?url=${b64}${suffix}`;
          } catch (e) {
            return match;
          }
        });

        // Pass 2: rewrite remaining absolute URLs (inline CSS, JS strings, etc.)
        const modifiedText = text.replace(/https?:\/\/[^\s'"<>)]+/g, (match) => {
          try {
            if (match.includes("convex.buengx.workers.dev")) return match;
            const b64 = btoa(match).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            return `https://convex.buengx.workers.dev/?url=${b64}`;
          } catch (e) {
            return match;
          }
        });

        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.delete("Content-Security-Policy");
        newHeaders.delete("X-Frame-Options");
        newHeaders.delete("Content-Length");
        
        const setCookie = response.headers.get("Set-Cookie");
        if (setCookie) newHeaders.set("Set-Cookie", setCookie);

        return new Response(modifiedText, {
          status: response.status,
          headers: newHeaders
        });
      }

      // Handle CSS - rewrite url() references so fonts/images load through Convex
      if (contentType.includes("text/css")) {
        const text = await response.text();
        const modifiedText = text.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, urlVal) => {
          try {
            if (/^(data:|#)/.test(urlVal)) return match;
            if (urlVal.includes("convex.buengx.workers.dev")) return match;
            const absolute = new URL(urlVal, decodedUrl).href;
            const b64 = btoa(absolute).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            return `url("https://convex.buengx.workers.dev/?url=${b64}")`;
          } catch (e) {
            return match;
          }
        });

        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.delete("Content-Length");

        return new Response(modifiedText, {
          status: response.status,
          headers: newHeaders
        });
      }

      // Handle streams (text/event-stream, application/octet-stream, etc.)
      if (contentType.includes("text/event-stream") || contentType.includes("stream")) {
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        
        return new Response(response.body, {
          status: response.status,
          headers: newHeaders
        });
      }

      // Return everything else (images, JS, fonts, etc.) as-is
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");
      
      return new Response(response.body, {
        status: response.status,
        headers: newHeaders
      });

    } catch (e) {
      return new Response("Proxy Error: " + e.message, { status: 500 });
    }
  }
};