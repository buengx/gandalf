export default {
  async fetch(request, env, ctx) {
    const proxyBase = "https://convex.buengx.workers.dev/?url=";
    const workerUrl = new URL(request.url);
    const encodedUrl = workerUrl.searchParams.get('url');

    // Default to Google if no URL is provided
    if (!encodedUrl) {
      const defaultB64 = btoa("https://www.google.com/").replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return Response.redirect(proxyBase + defaultB64, 302);
    }

    try {
      const decodedUrl = atob(encodedUrl.replace(/-/g, '+').replace(/_/g, '/'));
      const targetUrl = new URL(decodedUrl);

      // 1. Prepare Request (Forwarding all search params and cookies)
      const modifiedRequest = new Request(decodedUrl, {
        method: request.method,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
          "Accept": request.headers.get("Accept"),
          "Accept-Language": request.headers.get("Accept-Language"),
          "Cookie": request.headers.get("Cookie"),
          "Referer": "https://www.google.com/"
        },
        // Forward the search body if it's a POST request
        body: (request.method === "POST" || request.method === "PUT") ? request.body : null,
        redirect: "manual"
      });

      const response = await fetch(modifiedRequest);

      // 2. Handle Search Redirects (Google often redirects /search to specialized paths)
      if ([301, 302, 307, 308].includes(response.status)) {
        const loc = response.headers.get("Location");
        if (loc) {
          const absolute = new URL(loc, decodedUrl).href;
          const b64 = btoa(absolute).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          return Response.redirect(proxyBase + b64, 302);
        }
      }

      const contentType = response.headers.get("Content-Type") || "";

      // 3. Process HTML for Search Results
      if (contentType.includes("text/html")) {
        let text = await response.text();

        // Regex for deep replacement of Google's internal search links
        const modifiedText = text.replace(/(https?:\/\/[^\s'"><]+|(?<=src="|href="|url\()\/[^\s'"><)]+)/g, (match) => {
          try {
            // Avoid double-proxying
            if (match.includes("convex.buengx.workers.dev")) return match;
            
            const absolute = new URL(match, decodedUrl).href;
            const b64 = btoa(absolute).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            return proxyBase + b64;
          } catch (e) {
            return match;
          }
        });

        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.delete("Content-Security-Policy");
        newHeaders.delete("X-Frame-Options");
        
        // Ensure cookies (Consent/Search preferences) are passed back to the user
        const setCookie = response.headers.get("Set-Cookie");
        if (setCookie) newHeaders.set("Set-Cookie", setCookie);

        return new Response(modifiedText, {
          status: response.status,
          headers: newHeaders
        });
      }

      // 4. Return everything else (Images/JS/CSS) as-is
      return response;

    } catch (e) {
      return new Response("Search Error: " + e.message, { status: 500 });
    }
  }
};
