export default {
  async fetch(request, env, ctx) {
    const workerUrl = new URL(request.url);
    const encodedUrl = workerUrl.searchParams.get('url');

    // Default to Google if no URL is provided
    if (!encodedUrl) {
      const defaultB64 = btoa("https://www.google.com/")
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      return Response.redirect(`https://convex.buengx.workers.dev/?url=${defaultB64}`, 302);
    }

    try {
      const decodedUrl = atob(encodedUrl.replace(/-/g, '+').replace(/_/g, '/'));

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

        const CONVEX_ORIGIN = "https://convex.buengx.workers.dev";

        const toConvexUrl = (raw) => {
          // raw might be:
          // - absolute: https://www.example.com/test.jpg
          // - root-relative: /test.jpg
          // - scheme-relative: //www.example.com/test.jpg
          // - host/path without scheme: www.example.com/test.jpg
          // - path-only: test.jpg
          // - mailto:, javascript:, data: etc. (leave alone)
          try {
            if (!raw) return raw;
            const trimmed = String(raw).trim();

            // Ignore non-fetchable / special schemes
            if (/^(data:|mailto:|javascript:|tel:|about:|blob:|#)/i.test(trimmed)) return raw;

            // Avoid double-wrapping convex links
            if (trimmed.includes("convex.buengx.workers.dev")) return raw;

            let absolute;

            // Scheme-relative
            if (trimmed.startsWith("//")) {
              absolute = new URL("https:" + trimmed).href;
            }
            // Already absolute with a scheme
            else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
              absolute = new URL(trimmed).href;
            }
            // Root-relative
            else if (trimmed.startsWith("/")) {
              absolute = new URL(trimmed, decodedUrl).href;
            }
            // Host/path without scheme (e.g. www.example.com/test.jpg)
            else if (/^[^\s"'<>]+\.[^\s"'<>]+\//.test(trimmed)) {
              absolute = new URL("https://" + trimmed).href;
            }
            // Path-only like test.jpg, ./test.jpg, ../test.jpg
            else {
              absolute = new URL(trimmed, decodedUrl).href;
            }

            const b64 = btoa(absolute)
              .replace(/\+/g, '-')
              .replace(/\//g, '_')
              .replace(/=+$/, '');
            return `${CONVEX_ORIGIN}/?url=${b64}`;
          } catch {
            return raw;
          }
        };

        // Rewrite URLs that appear in common attribute / CSS contexts.
        // NOTE: this intentionally catches things like `src="www.example.com/test.jpg"`
        //       and `url(www.example.com/test.jpg)` in addition to absolute URLs.
        const modifiedText = text.replace(
          /(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]+|(?<=src=|href=|action=|poster=|data-src=|data-href=|data-url=|content=)[^\s"'<>]+|(?<=url\()\s*[^\s"'<>)]+\s*(?=\))/g,
          (match) => {
            // strip surrounding quotes/spaces for url( ... ) capture
            const cleaned = match.trim().replace(/^['"]|['"]$/g, '');
            return toConvexUrl(cleaned);
          }
        );

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