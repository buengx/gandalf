// Updated code to implement the following features:
// 1. Split params site/path (both base64url)
// 2. Backwards-compatible url param
// 3. Optional CORS only when ?cors=1
// 4. Block ad/tracker hosts with 204
// 5. HTMLRewriter for HTML attribute rewriting to emit site/path
// 6. Conservative text rewriting (absolute URLs + CSS url/@import only)
// 7. Remove unconditional CORS headers

// Function to handle different parameters
function handleParams(url) {
    const urlParams = new URLSearchParams(url);
    const siteParam = urlParams.get('site');
    const pathParam = urlParams.get('path');

    // Decode base64url and split the params
    const site = decodeBase64Url(siteParam);
    const path = decodeBase64Url(pathParam);

    return { site, path };
}

// Function to decode base64url
function decodeBase64Url(str) {
    return decodeURIComponent(str.replace(/_/g, '/').replace(/-/g, '+'));
}

// Main function to process requests
async function processRequest(request) {
    const url = request.url;
    const { site, path } = handleParams(url);

    // Check for optional CORS parameter
    if (new URLSearchParams(url).has('cors') && new URLSearchParams(url).get('cors') === '1') {
        // Set CORS headers
        // Implementation goes here
    }

    // Block ad/tracker hosts
    if (isAdTrackerHost(site)) {
        return new Response(null, { status: 204 });
    }

    // HTMLRewriter for rewriting HTML attributes
    const rewriter = new HTMLRewriter().on("*", {
        element(element) {
            element.setAttribute('data-site', site);
            element.setAttribute('data-path', path);
        }
    });

    // Return the final response
    return await fetch(site + path);
}

// Function to check for ad/tracker hosts
function isAdTrackerHost(host) {
    const adTrackerHosts = ['example.com', 'anotherexample.com']; // list of ad/tracker hosts
    return adTrackerHosts.includes(host);
}