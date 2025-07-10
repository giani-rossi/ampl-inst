const syncAmplemarketToInstantly = require('../sync'); // Ajustá el path si hace falta

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
const { amplemarketToken, instantlyV2Token, instantlyV1ApiKey } = req.body;

    if (!amplemarketToken || !instantlyToken) {
      return res.status(400).json({ error: 'Missing tokens' });
    }

const result = await syncAmplemarketToInstantly(amplemarketToken, instantlyV2Token, instantlyV1ApiKey);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};
