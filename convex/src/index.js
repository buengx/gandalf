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

      // Fetch the target
      const response = await fetch(decodedUrl, {
        method: request.method,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
          "Accept": request.headers.get("Accept"),
          "Accept-Language": request.headers.get("Accept-Language"),
          "Cookie": request.headers.get("Cookie"),
          "Referer": decodedUrl
        },
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

      // Handle streams (text/event-stream, application/octet-stream, etc.)
      if (contentType.includes("text/event-stream") || contentType.includes("stream")) {
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        
        return new Response(response.body, {
          status: response.status,
          headers: newHeaders
        });
      }

      // Return everything else (images, CSS, JS, etc.) as-is
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