export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const SECRET_SALT = env.GATEKEEPER_SECRET || "mylifeisalie";

      // --- TIME KEY CALCULATION ---
      let timeKey;
      try {
        const aest = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Australia/Sydney',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', hour12: false
        }).format(new Date());

        const [date, hour] = aest.split(', ');
        const [d, m, y] = date.split('/');
        timeKey = `${y}-${m}-${d}T${hour}`;
      } catch (timeError) {
        return new Response("Time Formatting Error: " + timeError.message, { status: 500 });
      }

      // --- AUTH CHECK ---
      const dailyPassword = await generateCode(timeKey + SECRET_SALT);
      const userPass = url.searchParams.get("pw");

      if (!userPass || userPass !== dailyPassword) {
        return new Response("Forbidden: Check your PW. Expected: " + dailyPassword + " Got: " + userPass, { status: 403 });
      }

      // --- CATCH-ALL: Forward everything to Convex ---
      const b64Param = url.searchParams.get("url");
      let convexUrl;

      if (b64Param) {
        // Already has URL param, just pass to convex
        convexUrl = `https://convex.buengx.workers.dev/?url=${b64Param}`;
      } else {
        // Catch-all: reconstruct target URL from path + query (minus pw)
        const queryWithoutPw = url.search.replace(/[?&]pw=[^&]*/g, '').replace(/^&/, '?');
        const reconstructedUrl = `https://www.google.com${url.pathname}${queryWithoutPw}`;
        const b64 = btoa(reconstructedUrl).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        convexUrl = `https://convex.buengx.workers.dev/?url=${b64}`;
      }

      // Forward to Convex and return response
      const convexResponse = await fetch(convexUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body
      });

      return convexResponse;

    } catch (globalError) {
      return new Response("CRITICAL EXCEPTION: " + globalError.stack, { status: 500 });
    }
  }
};

async function generateCode(message) {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("").substring(0, 8);
}