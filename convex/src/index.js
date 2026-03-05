'use strict';

const { decodeURIComponent, encodeURIComponent } = require('url');

/**
 * The fetch handler to respond to requests, using Cloudflare Worker’s global context.
 * @param {Request} request The incoming request.
 * @returns {Response} The response to return.
 */
 export default async function fetchHandler(request) {
    const urlParams = new URL(request.url).searchParams;

    // Decode and sanitize the URL parameter
    const urlParam = decodeURIComponent(urlParams.get('url') || '')
        .trim() // remove white spaces
        .replace(/^"|"$/g, ''); // remove quotes

    // Check if the URL param is empty
    if (!urlParam) {
        return new Response('Missing url parameter', { status: 400 });
    }

    // Handle fetching and other logic here... (add your logic accordingly)

    return new Response('OK'); // Respond with OK for successful requests
 }
