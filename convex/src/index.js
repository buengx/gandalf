// URL Proxying and Base64 Encoding Fetch Handler

export default async function handler(req) {
    const { method, headers, body } = req;

    // Set the URL you want to proxy
    const url = "https://example.com/api";

    // Fetch options
    const options = {
        method,
        headers: {
            ...headers,
            // Optional: Set additional headers if needed
        },
        body: method === "GET" ? null : Buffer.from(JSON.stringify(body)).toString('base64'), // Base64 encoding for body
    };

    // Fetch the data
    const response = await fetch(url, options);
    const data = await response.json();

    return new Response(JSON.stringify(data), {
        status: response.status,
        headers: {
            'Content-Type': 'application/json',
        },
    });
}