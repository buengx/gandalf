export default async function handler(req, res) {
    const now = new Date();
    const startTime = new Date('2026-02-17T23:25:39Z');
    const expirationTime = new Date(startTime.getTime() + 60 * 1000); // 1 minute expiration

    if (now < startTime || now > expirationTime) {
        return res.status(401).json({ error: 'Authentication failed: Time-based password has expired.' });
    }

    // Proxy logic (assuming you have a proxy mechanism set up)
    const targetUrl = 'https://example.com/api';
    const response = await fetch(targetUrl);
    const data = await response.json();

    return res.status(200).json(data);
}