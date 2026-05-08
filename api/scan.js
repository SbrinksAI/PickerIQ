export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, category } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });
  if (!category) return res.status(400).json({ error: 'No category provided' });

  const EBAY_CAT_IDS = {
    books: '267', bluray: '617', cds: '176984', vhs: '309',
    cassettes: '176983', videogames: '1249', toys: '220', sportscards: '212'
  };

  const CATEGORY_PROMPTS = {
    books: `You are an expert rare book reseller with 30 years of estate sale experience.
Identify every book visible and assess if it could be worth over $20.
Key value factors: first edition/first printing on copyright page, number line ending in 1, author signature, dust jacket presence and condition, publisher and imprint, ARCs or uncorrected proofs, limitation statement on numbered editions, book club editions (no price on jacket flap) are LESS valuable.`,
    bluray: `You are an expert Blu-ray and DVD reseller with 30 years of estate sale experience.
Identify every Blu-ray and DVD visible.
Key value factors: out of print status, Limited Edition/Steelbook/Collector packaging, Criterion Collection, Region B or region free, sealed shrinkwrap, all extras present, retailer exclusives, foreign releases, first pressing vs later reissues.`,
    cds: `You are an expert music CD reseller with 30 years of estate sale experience.
Identify every CD visible.
Key value factors: original pressing vs reissue, promo copies marked Not For Sale, Japanese imports with OBI strip, limited edition or numbered releases, colored or picture discs, all original inserts present, HDCD/SACD audiophile formats.`,
    vhs: `You are an expert VHS tape reseller with 30 years of estate sale experience.
Identify every VHS tape visible.
Key value factors: sealed shrinkwrap, big box releases from early 1980s, Disney Black Diamond edition, first release before reissues, horror/cult/exploitation titles, ex-rental vs retail, slipcovers or special packaging.`,
    cassettes: `You are an expert cassette tape reseller with 30 years of estate sale experience.
Identify every cassette tape visible.
Key value factors: sealed copies, original pressing vs reissue, hip hop/metal/punk original pressings most valuable, chrome or metal tape formulation, limited releases or demo tapes, promo copies, original J-card in good condition.`,
    videogames: `You are an expert video game reseller with 30 years of estate sale experience.
Identify every video game, console, or gaming accessory visible.
Key value factors: Complete in Box (CIB), black label original vs Greatest Hits (red label), sealed shrinkwrap, first print variants, all inserts and maps present, region variants, Limited or Collector editions, key platforms: PS1, PS2, GameCube, N64, Dreamcast, Saturn.`,
    toys: `You are an expert toy and action figure reseller with 30 years of estate sale experience.
Identify every toy, action figure, diecast, or collectible figure visible.
Key value factors: Mint on Card (MOC) or Mint in Box (MIB), first run production markings, exact product line (vintage vs modern), country of manufacture stamp (Hong Kong = older), factory errors or color variants, all original accessories present, major lines: Star Wars, GI Joe, He-Man, Transformers, TMNT, Marvel, DC.`,
    sportscards: `You are an expert sports card and trading card reseller with 30 years of estate sale experience.
Identify every sports card, Pokemon card, or trading card visible.
Key value factors: exact set name and year, rookie cards (RC), card condition, parallel versions, autograph or patch/relic cards, print run number on card, Pokemon first edition stamp bottom left, shadowless vs shadow border, error cards, graded cards in PSA/BGS/CGC slabs.`
  };

  const categoryPrompt = CATEGORY_PROMPTS[category] || CATEGORY_PROMPTS.books;
  const ebayCatId = EBAY_CAT_IDS[category] || '267';
  const cache = global._pickeriqCache = global._pickeriqCache || {};

  // Get eBay OAuth token
  async function getEbayToken() {
    const cached = cache['_ebay_token'];
    if (cached && Date.now() < cached.expires) return cached.token;
    const credentials = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
    });
    if (!tokenRes.ok) throw new Error('eBay token error: ' + (await tokenRes.text()).slice(0, 200));
    const tokenData = await tokenRes.json();
    cache['_ebay_token'] = { token: tokenData.access_token, expires: Date.now() + (tokenData.expires_in - 60) * 1000 };
    return tokenData.access_token;
  }

  // Sanitize query — strip to title + author, remove special chars and extra details
  function sanitizeQuery(item) {
    const title = (item.title || '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const author = (item.artist_author || '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    return `${title} ${author}`.trim().slice(0, 100);
  }

  // Original eBay lookup chain (v5):
  // 1. Sanitized title + author query → Finding API sold listings
  // 2. Fall back to Browse API active listings
  async function getEbayPrices(item, catId, token) {
    const cacheKey = `${catId}:${item.title}`;
    const cached = cache[cacheKey];
    if (cached && (Date.now() - cached.ts) < 3600000) return cached.prices;

    const query = sanitizeQuery(item);

    // Attempt 1: Finding API sold listings
    try {
      const url = `https://svcs.ebay.com/services/search/FindingService/v1` +
        `?OPERATION-NAME=findCompletedItems` +
        `&SERVICE-VERSION=1.0.0` +
        `&SECURITY-APPNAME=${process.env.EBAY_APP_ID}` +
        `&RESPONSE-DATA-FORMAT=JSON` +
        `&keywords=${encodeURIComponent(query)}` +
        `&categoryId=${catId}` +
        `&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true` +
        `&sortOrder=EndTimeSoonest` +
        `&paginationInput.entriesPerPage=10`;
      const res = await fetch(url);
      const data = await res.json();
      const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
      if (items.length > 0) {
        const prices = items
          .map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__']))
          .filter(p => !isNaN(p) && p > 0).sort((a,b) => a-b);
        if (prices.length > 0) {
          const result = {
            min: Math.round(prices[0]),
            max: Math.round(prices[prices.length-1]),
            avg: Math.round(prices.reduce((a,b) => a+b,0) / prices.length),
            count: prices.length,
            source: 'ebay_sold'
          };
          cache[cacheKey] = { prices: result, ts: Date.now() };
          return result;
        }
      }
    } catch(e) {}

    // Attempt 2: Browse API active listings fallback
    if (token) {
      try {
        const res = await fetch(
          `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=10&sort=price`,
          { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } }
        );
        const data = await res.json();
        const items = data?.itemSummaries || [];
        if (items.length > 0) {
          const prices = items.map(i => parseFloat(i.price?.value)).filter(p => !isNaN(p) && p > 0).sort((a,b) => a-b);
          if (prices.length > 0) {
            const result = {
              min: Math.round(prices[0]),
              max: Math.round(prices[prices.length-1]),
              avg: Math.round(prices.reduce((a,b) => a+b,0) / prices.length),
              count: prices.length,
              source: 'ebay_active'
            };
            cache[cacheKey] = { prices: result, ts: Date.now() };
            return result;
          }
        }
      } catch(e) {}
    }

    cache[cacheKey] = { prices: null, ts: Date.now() };
    return null;
  }

  // Assign value tier from eBay average
  function getTierFromAvg(avg) {
    if (avg === null || avg === undefined) return null;
    if (avg >= 50) return 'high';
    if (avg >= 20) return 'medium';
    return 'low';
  }

  try {
    // Step 1: Claude reads image
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 4000,
        system: `${categoryPrompt}

For every item potentially worth over $20 provide details and a plain English location description.

Return ONLY raw JSON — no markdown, no backticks:
{
  "total_items_spotted": NUMBER,
  "items": [
    {
      "title": "exact title or name",
      "artist_author": "artist, author, or manufacturer",
      "reason": "1-2 sentences why this specific item could be valuable",
      "what_to_check": ["specific check that applies to THIS item only"],
      "ebay_search_query": "optimized eBay search string",
      "location_description": "plain English location e.g. Third from the left, red spine, between the two tall hardcovers"
    }
  ]
}

Only include items potentially worth over $20.
what_to_check must only contain checks specific to THIS exact item.
If nothing identifiable: {"total_items_spotted":0,"items":[]}`,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: `Analyze this photo of ${category} and identify all potentially valuable items. Return only the JSON.` }
          ]
        }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      if (err.includes('overloaded')) return res.status(503).json({ error: 'overloaded' });
      return res.status(500).json({ error: 'Claude API error: ' + err.slice(0, 300) });
    }

    const claudeData = await claudeRes.json();
    const raw = claudeData.content.map(b => b.text || '').join('');
    const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
    if (first === -1) return res.status(500).json({ error: 'No JSON returned.' });
    const parsed = JSON.parse(raw.slice(first, last + 1));
    const items = parsed.items || [];

    // Step 2: Get eBay token
    let ebayToken = null;
    try { ebayToken = await getEbayToken(); } catch(e) {}

    // Step 3: Fetch eBay prices in parallel
    const itemsWithPrices = await Promise.all(
      items.map(async (item) => {
        const prices = await getEbayPrices(item, ebayCatId, ebayToken);
        const tier = prices ? getTierFromAvg(prices.avg) : null;
        const valueRange = prices ? `$${prices.min}–$${prices.max}` : null;
        return {
          ...item,
          ebay_prices: prices,
          value_tier: tier,
          value_range_estimate: valueRange,
          ebay_search_url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(item.ebay_search_query || item.title)}&_sacat=${ebayCatId}&LH_Complete=1&LH_Sold=1`
        };
      })
    );

    // Sort: items with prices first by avg desc, then no-price items
    itemsWithPrices.sort((a, b) => {
      const aAvg = a.ebay_prices?.avg ?? -1;
      const bAvg = b.ebay_prices?.avg ?? -1;
      return bAvg - aAvg;
    });

    return res.status(200).json({
      total_items_spotted: parsed.total_items_spotted,
      items: itemsWithPrices
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
