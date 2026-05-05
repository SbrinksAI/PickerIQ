export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const key = process.env.ANTHROPIC_API_KEY;
  const ebay = process.env.EBAY_APP_ID;
  res.status(200).json({
    anthropic_key_exists: !!key,
    anthropic_key_preview: key ? key.slice(0, 12) + '...' : 'NOT FOUND',
    ebay_key_exists: !!ebay,
    ebay_key_preview: ebay ? ebay.slice(0, 12) + '...' : 'NOT FOUND'
  });
}
