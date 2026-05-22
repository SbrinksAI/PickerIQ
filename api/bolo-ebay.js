export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

  try {
    // Step 1 — Claude identifies item and generates eBay query
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: 'Identify this item. Return ONLY raw JSON, no markdown: {"item_name":"exact name","ebay_query":"title and brand only max 4 words no descriptors","category_id":"267"}. Use eBay category IDs: books=267, toys=220, games=1249, records=176985, comics=259104, collectibles=1, electronics=293. Pick the best match.' }
          ]
        }]
      })
    });

    if (!claudeRes.ok) throw new Error('Claude error: ' + claudeRes.status);
    const claudeData = await claudeRes.json();
    const raw = claudeData.content.map(b => b.text || '').join('');
    const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
    if (first === -1) throw new Error('No JSON from Claude');
    const identified = JSON.parse(raw.slice(first, last + 1));

    const query = identified.ebay_query || identified.item_name || '';
    const catId = identified.category_id || '1';

    // Step 2 — Get eBay token
    const credentials = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;

    // Step 3 — Browse API active listings (most reliable)
    let listings = [];
    if (token) {
      const browseRes = await fetch(
        `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=5`,
        { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } }
      );
      const browseData = await browseRes.json();
      listings = (browseData?.itemSummaries || []).slice(0, 3).map(item => ({
        title: item.title,
        price: item.price?.value ? `$${parseFloat(item.price.value).toFixed(2)}` : null,
        condition: item.condition || 'Used',
        image: item.image?.imageUrl || null,
        url: item.itemWebUrl || `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Complete=1&LH_Sold=1`
      }));
    }

    // Step 4 — Also try Finding API for sold listings
    const findingUrl = `https://svcs.ebay.com/services/search/FindingService/v1` +
      `?OPERATION-NAME=findCompletedItems` +
      `&SERVICE-VERSION=1.0.0` +
      `&SECURITY-APPNAME=${process.env.EBAY_APP_ID}` +
      `&RESPONSE-DATA-FORMAT=JSON` +
      `&keywords=${encodeURIComponent(query)}` +
      `&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true` +
      `&sortOrder=EndTimeSoonest` +
      `&paginationInput.entriesPerPage=3`;

    let soldListings = [];
    try {
      const findRes = await fetch(findingUrl);
      const findData = await findRes.json();
      const items = findData?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
      soldListings = items.slice(0, 3).map(item => ({
        title: item.title?.[0] || query,
        price: item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__']
          ? `$${parseFloat(item.sellingStatus[0].currentPrice[0]['__value__']).toFixed(2)}`
          : null,
        condition: item.condition?.[0]?.conditionDisplayName?.[0] || 'Used',
        soldDate: item.listingInfo?.[0]?.endTime?.[0]?.slice(0, 10) || null,
        url: item.viewItemURL?.[0] || `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Complete=1&LH_Sold=1`,
        sold: true
      }));
    } catch(e) {}

    const allListings = [...soldListings, ...listings].slice(0, 5);

    return res.status(200).json({
      item_name: identified.item_name,
      query,
      ebay_search_url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Complete=1&LH_Sold=1`,
      listings: allListings
    });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
