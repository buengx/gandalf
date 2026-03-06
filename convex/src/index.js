const HTMLRewriter = require('html-rewriter');

const rewriteRootRelativePaths = (trimmed, baseUrl) => {
    // Rewrites root-relative paths like /logo.webp
    return new URL(trimmed, baseUrl).href;
};

const handleElementsWithAttributes = (element) => {
    const attributes = ['data-href', 'data-srcset', 'data-lazy-src', 'data-original'];
    attributes.forEach(attr => {
        const value = element.getAttribute(attr);
        if (value) {
            element.setAttribute(attr, rewriteRootRelativePaths(value, baseUrl));
        }
    });
};

const htmlRewriter = new HTMLRewriter()
    .on('img', {
        element(element) {
            // Handle <img src="/logo.webp">
            const src = element.getAttribute('src');
            if (src) {
                element.setAttribute('src', rewriteRootRelativePaths(src, baseUrl));
            }
        }
    })
    .on('*', {
        element(element) {
            handleElementsWithAttributes(element);
        }
    });

addEventListener('fetch', event => {
    const request = event.request;
    const response = fetch(request);
    response.headers.append('Connection', 'close'); // Best-effort to add Connection: close
    response.headers.set('Upstream-Connection', 'close'); // Set upstream request header Connection: close
    event.respondWith(htmlRewriter.transform(response));
});
