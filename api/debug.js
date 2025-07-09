// /api/debug.js

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { amplemarketToken, instantlyToken } = req.body;

    if (!amplemarketToken || !instantlyToken) {
      return res.status(400).json({ error: 'Missing tokens' });
    }

    res.status(200).json({
      message: 'Debug endpoint working!',
      amplemarketToken: amplemarketToken.slice(0, 5) + '...',
      instantlyToken: instantlyToken.slice(0, 5) + '...',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
