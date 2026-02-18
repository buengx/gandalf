export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const SECRET_SALT = env.GATEKEEPER_SECRET || "mylifeisalie";
      const NOPE_LIST = ["cstv", "csv", "tsv"];

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
        return new Response("Forbidden: Check your PW.", { status: 403 });
      }

      // --- URL DECODING ---
      const b64Param = url.searchParams.get("url");
      if (!b64Param) return new Response("Error: No URL param.", { status: 400 });

      let targetStr;
      try {
        targetStr = atob(b64Param).trim();
        if (!targetStr.startsWith("http")) targetStr = "https://" + targetStr;
      } catch (b64Error) {
        return new Response("Base64 Decode Error: " + b64Error.message, { status: 400 });
      }

      // --- PROXY LOGIC ---
      const targetUrl = new URL(targetStr);
      if (NOPE_LIST.some(word => targetUrl.hostname.toLowerCase().includes(word))) {
        return new Response("Nope.", { status: 403 });
      }

      const newHeaders = new Headers(request.headers);
      newHeaders.set("Host", targetUrl.hostname);

      const proxyResponse = await fetch(new Request(targetUrl, {
        method: request.method,
        headers: newHeaders,
        body: request.body,
        redirect: "follow"
      }));

      // Check if Convex sent a redirect signal
      const redirectTo = proxyResponse.headers.get("X-Redirect-To");
      if (redirectTo) {
        // Preserve pw in the redirect
        const redirectUrl = new URL(redirectTo);
        redirectUrl.searchParams.set("pw", userPass);
        return Response.redirect(redirectUrl.toString(), 302);
      }

      return proxyResponse;

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