export default {
  async fetch(request, env, ctx) {
    const workerUrl = new URL(request.url);
    const encodedUrl = workerUrl.searchParams.get("url");

    // Default to Google if no URL is provided
    if (!encodedUrl) {
      const defaultB64 = btoa("https://www.google.com/")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      return Response.redirect(
        `https://convex.buengx.workers.dev/?url=${defaultB64}`,
        302
      );
    }

    try {
      const decodedUrl = atob(encodedUrl.replace(/-/g, "+").replace(/_/g, "/"));

      // Fetch the target
      const response = await fetch(decodedUrl, {
        method: request.method,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
          Accept: request.headers.get("Accept"),
          "Accept-Language": request.headers.get("Accept-Language"),
          Cookie: request.headers.get("Cookie"),
          Referer: decodedUrl,
        },
        body:
          request.method === "POST" || request.method === "PUT"
            ? request.body
            : null,
        redirect: "follow",
      });

      const contentType = response.headers.get("Content-Type") || "";

      // Handle HTML - rewrite URLs to point to Convex (NOT Gandalf)
      if (contentType.includes("text/html")) {
        const text = await response.text();
        const CONVEX_ORIGIN = "https://convex.buengx.workers.dev";

        const toConvexUrl = (raw) => {
          try {
            if (!raw) return raw;
            const trimmed = String(raw).trim();

            // Ignore non-fetchable / special schemes / fragments
            if (/^(data:|mailto:|javascript:|tel:|about:|blob:|#)/i.test(trimmed))
              return raw;

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
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, "");
            return `${CONVEX_ORIGIN}/?url=${b64}`;
          } catch {
            return raw;
          }
        };

        const rewriteAttr = (whole, prefix, value, suffix) => {
          const cleaned = value.trim().replace(/^['"]|['"]$/g, "");
          return `${prefix}${toConvexUrl(cleaned)}${suffix}`;
        };

        // 1) Rewrite common HTML attrs that contain URLs (no lookbehind)
        // Matches: src="...", href='...', action=..., poster=..., data-src=..., etc.
        let modifiedText = text.replace(
          /(\b(?:src|href|action|poster|data-src|data-href|data-url|content)\s*=\s*)(["']?)([^"'\s>]+)\2/gi,
          (whole, prefix, quote, value) => rewriteAttr(whole, prefix, value, quote)
        );

        // 2) Rewrite CSS url(...) (no lookbehind)
        // Matches: url(test.jpg) url("test.jpg") url('test.jpg')
        modifiedText = modifiedText.replace(
          /(url\(\s*)(["']?)([^"')\s][^"')]*?)\2(\s*\))/gi,
          (whole, prefix, quote, value, suffix) =>
            `${prefix}${quote}${toConvexUrl(value)}${quote}${suffix}`
        );

        // 3) Rewrite plain absolute URLs in text as a fallback (optional)
        modifiedText = modifiedText.replace(/https?:\/\/[^\s"'<>]+/g, (u) =>
          toConvexUrl(u)
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
          headers: newHeaders,
        });
      }

      // Handle streams (text/event-stream, application/octet-stream, etc.)
      if (contentType.includes("text/event-stream") || contentType.includes("stream")) {
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");

        return new Response(response.body, {
          status: response.status,
          headers: newHeaders,
        });
      }

      // Return everything else (images, CSS, JS, etc.) as-is
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");

      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
    } catch (e) {
      return new Response("Proxy Error: " + e.message, { status: 500 });
    }
  },
};