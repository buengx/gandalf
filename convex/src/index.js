async function rewriteResponse(response) {
  const body = await response.text();
  const rewrittenBody = body
    // Rewrite video and audio src attributes
    .replace(/<video[^>]*src="(.*?)"/g, `<video src="https://convex.example.com/$1" data-original="$1" data-lazy-src="https://convex.example.com/$1"`) // video
    .replace(/<audio[^>]*src="(.*?)"/g, `<audio src="https://convex.example.com/$1" data-original="$1" data-lazy-src="https://convex.example.com/$1"`) // audio
    // Rewrite URLs from coolmathgames
    .replace(/https:\/\/www\.coolmathgames\.com\/([^" ]*)/g, 'https://convex.example.com/$1')
    // Other transformations can be added here
    ;

  // Include response headers
  const headers = new Headers(response.headers);
  headers.set('Connection', 'close');
  headers.set('Keep-Alive', 'timeout=0, max=0');

  return new Response(rewrittenBody, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}