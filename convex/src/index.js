const url = require('url');

function decodeBase64Url(base64Url) {
    // URL-decode the base64 URL parameter
    const decodedUrl = decodeURIComponent(base64Url);
    // Decode the base64 string using atob()
    return atob(decodedUrl);
}

// Example usage
const base64Url = "aHR0cHM6Ly93d3cueW91bHRpb25sLmNvbS8="; // Example Base64 URL
const decoded = decodeBase64Url(base64Url);
console.log(decoded);