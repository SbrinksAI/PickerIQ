export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, category } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });
  if (!category) return res.status(400).json({ error: 'No category provided' });

  const EBAY_CATEGORIES = {
    books: 'Books', bluray: 'DVDs & Blu-ray Discs', cds: 'Music CDs',
    vhs: 'VHS Tapes', cassettes: 'Cassettes', videogames: 'Video Games',
    toys: 'Toys & Hobbies', sportscards: 'Sports Trading Cards'
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
Key value factors: Complete in Box (CIB), black label original vs Greatest Hits (red label), sealed shrinkwrap, first print variants, all inserts and maps present, region variants, Limited or Collector editions, key platforms: PS1, PS2, GameCube, N64, Dreamcast, Saturn.
NOTE: This is an experimental category — accuracy may be lower than media categories.`,
    toys: `You are an expert toy and action figure reseller with 30 years of estate sale experience.
Identify every toy, action figure, diecast, or collectible figure visible.
Key value factors: Mint on Card (MOC) or Mint in Box (MIB), first run production markings, exact product line (vintage vs modern), country of manufacture stamp (Hong Kong = older), factory errors or color variants, all original accessories present, major lines: Star Wars, GI Joe, He-Man, Transformers, TMNT, Marvel, DC.
NOTE: This is an experimental category — accuracy may be lower than media categories.`,
    sportscards: `You are an expert sports card and trading card reseller with 30 years of estate sale experience.
Identify every sports card, Pokemon card, or trading card visible.
Key value factors: exact set name and year, rookie cards (RC), card condition, parallel versions — holographic refractor foil serial numbered, autograph or patch/relic cards, print run number on card, Pokemon first edition stamp bottom left, shadowless vs shadow border, error cards, graded cards in PSA/BGS/CGC slabs.
NOTE: This is an experimental category — accuracy may be lower than media categories.`
  };

  const categoryPrompt = CATEGORY_PROMPTS[category] || CATEGORY_PROMPTS.books;
  const ebayCategory = EBAY_CATEGORIES[category] || 'Books';
  const cache = global._pickeriqCache = global._pickeriqCache || {};

  // Get eBay OAuth token using Client Credentials
  async function getEbayToken() {
    const tokenCacheKey = '_ebay_token';
    const cached = cache[tokenCacheKey];
    if (cached && Date.now() < cached.expires) return cached.token;

    const credentials = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error('eBay token error: ' + err.slice(0, 200));
    }

    const tokenData = await tokenRes.json();
    cache[tokenCacheKey] = {
      token: tokenData.access_token,
      expires: Date.now() + (tokenData.expires_in - 60) * 1000
    };
    return tokenData.access_token;
  }

  // Browse API sold items lookup
  async function getEbaySoldPrices(query, category, token) {
    const cacheKey = `${category}:${query}`;
    const cached = cache[cacheKey];
    if (cached && (Date.now() - cached.ts) < 3600000) return cached.prices;

    // Use Browse API to search completed/sold items
    const encodedQuery = encodeURIComponent(query);
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search` +
      `?q=${encodedQuery}` +
      `&category_ids=${encodedQuery}` +
      `&filter=buyingOptions%3A%7BFIXED_PRICE%7D,conditions%3A%7BUSED%7D` +
      `&sort=price` +
      `&limit=10`;

    // Use Finding API as primary — more reliable for sold data
    const findingUrl = `https://svcs.ebay.com/services/search/FindingService/v1` +
      `?OPERATION-NAME=findCompletedItems` +
      `&SERVICE-VERSION=1.0.0` +
      `&SECURITY-APPNAME=${process.env.EBAY_APP_ID}` +
      `&RESPONSE-DATA-FORMAT=JSON` +
      `&keywords=${encodedQuery}` +
      `&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true` +
      `&sortOrder=EndTimeSoonest` +
      `&paginationInput.entriesPerPage=10`;

    const findRes = await fetch(findingUrl);
    const findData = await findRes.json();
    const soldItems = findData?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];

    if (soldItems.length > 0) {
      const prices = soldItems
        .map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__']))
        .filter(p => !isNaN(p) && p > 0)
        .sort((a, b) => a - b);

      const result = {
        min: Math.round(prices[0]),
        max: Math.round(prices[prices.length - 1]),
        avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
        count: prices.length,
        source: 'ebay_sold'
      };
      cache[cacheKey] = { prices: result, ts: Date.now() };
      return result;
    }

    // Fallback to Browse API if Finding API returns nothing
    try {
      const browseRes = await fetch(
        `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodedQuery}&limit=10&sort=price`,
        { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } }
      );
      const browseData = await browseRes.json();
      const browseItems = browseData?.itemSummaries || [];

      if (browseItems.length > 0) {
        const prices = browseItems
          .map(i => parseFloat(i.price?.value))
          .filter(p => !isNaN(p) && p > 0)
          .sort((a, b) => a - b);

        const result = {
          min: Math.round(prices[0]),
          max: Math.round(prices[prices.length - 1]),
          avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
          count: prices.length,
          source: 'ebay_active'
        };
        cache[cacheKey] = { prices: result, ts: Date.now() };
        return result;
      }
    } catch(e) { /* Browse API fallback failed, return null */ }

    cache[cacheKey] = { prices: null, ts: Date.now() };
    return null;
  }

  try {
    // Step 1: Claude reads the image
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

For every item potentially worth over $20, provide details and a plain English location description.

Return ONLY raw JSON — no markdown, no backticks:
{
  "total_items_spotted": NUMBER,
  "items": [
    {
      "title": "exact title or name",
      "artist_author": "artist, author, or manufacturer",
      "value_tier": "high|medium|low",
      "reason": "1-2 sentences why this specific item could be valuable",
      "what_to_check": ["specific check that applies to THIS item only"],
      "tags": ["relevant tags"],
      "ebay_search_query": "optimized eBay search string",
      "location_description": "plain English location e.g. Third from the left, red spine, between the two tall hardcovers",
      "value_range_estimate": "$X-$Y"
    }
  ]
}

Sort items: high first, then medium, then low. Within each tier sort by likely value descending.
what_to_check must only contain checks specific to THIS exact item.
value_range_estimate should be conservative and realistic — never overestimate.
If nothing identifiable: {"total_items_spotted":0,"items":[]}`,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: `Analyze this photo of ${category} and identify all potentially valuable items. Return only the JSON, sorted highest to lowest value.` }
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
    if (first === -1) return res.status(500).json({ error: 'No JSON returned. Got: ' + raw.slice(0, 200) });

    const parsed = JSON.parse(raw.slice(first, last + 1));
    const items = parsed.items || [];

    // Step 2: Get eBay token
    let ebayToken = null;
    try { ebayToken = await getEbayToken(); } catch(e) { console.error('Token error:', e.message); }

    // Step 3: Fetch eBay prices in parallel
    const itemsWithPrices = await Promise.all(
      items.map(async (item) => {
        try {
          const prices = await getEbaySoldPrices(
            item.ebay_search_query || `${item.title} ${item.artist_author}`,
            category,
            ebayToken
          );

          // Override value_range_estimate with real eBay data if available
          const finalValueRange = prices
            ? `$${prices.min}–$${prices.max}`
            : item.value_range_estimate;

          return {
            ...item,
            ebay_prices: prices,
            value_range_estimate: finalValueRange,
            ebay_search_url: buildEbayUrl(item, category)
          };
        } catch(e) {
          return { ...item, ebay_prices: null, ebay_search_url: buildEbayUrl(item, category) };
        }
      })
    );

    // Final sort: tier first, then eBay avg descending within tier
    const tierOrd = { high: 0, medium: 1, low: 2 };
    itemsWithPrices.sort((a, b) => {
      const tierDiff = (tierOrd[a.value_tier] || 2) - (tierOrd[b.value_tier] || 2);
      if (tierDiff !== 0) return tierDiff;
      return (b.ebay_prices?.avg || 0) - (a.ebay_prices?.avg || 0);
    });

    return res.status(200).json({
      total_items_spotted: parsed.total_items_spotted,
      items: itemsWithPrices
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function buildEbayUrl(item, category) {
  const EBAY_CAT_IDS = {
    books: '267', bluray: '617', cds: '176984', vhs: '309',
    cassettes: '176983', videogames: '1249', toys: '220', sportscards: '212'
  };
  const q = encodeURIComponent(item.ebay_search_query || `${item.title} ${item.artist_author}`);
  const catId = EBAY_CAT_IDS[category] || '99';
  return `https://www.ebay.com/sch/i.html?_nkw=${q}&_sacat=${catId}&LH_Complete=1&LH_Sold=1`;
}
