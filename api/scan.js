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
    toys: '220', videogames: '1249', sportscards: '212',
    books: '267', bluray: '617', cds: '176984', vhs: '309', cassettes: '176983'
  };

  const CATEGORY_PROMPTS = {
    toys: `You are an expert toy and action figure reseller with 30 years of estate sale experience.
Identify every toy, action figure, diecast, or collectible figure visible.
Key value factors: Mint on Card (MOC) or Mint in Box (MIB), first run production markings, exact product line (vintage vs modern), country of manufacture stamp (Hong Kong = older = more valuable), factory errors or color variants, all original accessories present, retailer exclusives, major lines: Star Wars, GI Joe, He-Man, Transformers, TMNT, Marvel, DC.`,

    videogames: `You are an expert video game reseller with 30 years of estate sale experience.
Identify every video game, console, or gaming accessory visible.
Key value factors: Complete in Box (CIB) — game, case, AND manual, black label original vs Greatest Hits (red label), sealed shrinkwrap, first print variants, all inserts and maps present, region (NTSC vs PAL vs Japanese import), Limited or Collector editions, platform matters enormously, key platforms: PS1, PS2, GameCube, N64, Dreamcast, Saturn.`,

    sportscards: `You are an expert sports card and trading card reseller with 30 years of estate sale experience.
Identify every sports card, Pokemon card, or trading card visible.
Key value factors: exact set name and year, rookie cards (RC), card condition — corners edges surface centering, parallel versions — holographic refractor foil serial numbered, autograph or patch/relic cards, print run number on card (/25 /10 /1), Pokemon first edition stamp bottom left, shadowless vs shadow border, error cards, graded cards in PSA/BGS/CGC slabs.`,

    books: `You are an expert rare book reseller with 30 years of estate sale experience.
Identify every book visible and assess if it could be worth over $20.
Key value factors: first edition/first printing on copyright page, number line ending in 1, author signature, dust jacket presence and condition, publisher and imprint, ARCs or uncorrected proofs, limitation statement on numbered editions, book club editions (no price on jacket flap) are LESS valuable, inscriptions or bookplates.`,

    bluray: `You are an expert Blu-ray and DVD reseller with 30 years of estate sale experience.
Identify every Blu-ray and DVD visible.
Key value factors: out of print status, Limited Edition/Steelbook/Collector packaging, Criterion Collection, Region B or region free, sealed shrinkwrap, all extras present — slipcovers booklets art cards, retailer exclusives, foreign releases of films never released domestically, first pressing vs later reissues.`,

    cds: `You are an expert music CD reseller with 30 years of estate sale experience.
Identify every CD visible.
Key value factors: original pressing vs reissue — check catalog number, promo copies marked Not For Sale, Japanese imports with OBI strip, limited edition or numbered releases, catalog number format identifies pressing country and era, colored or picture discs, all original inserts present, HDCD/SACD audiophile formats, autographed inserts.`,

    vhs: `You are an expert VHS tape reseller with 30 years of estate sale experience.
Identify every VHS tape visible.
Key value factors: sealed shrinkwrap, big box releases from early 1980s, Disney Black Diamond edition, first release before reissues, horror/cult/exploitation titles — most valuable VHS category, ex-rental vs retail, slipcovers or special packaging, clamshell cases vs cardboard sleeves, UK PAL releases.`,

    cassettes: `You are an expert cassette tape reseller with 30 years of estate sale experience.
Identify every cassette tape visible.
Key value factors: sealed copies, original pressing vs reissue — check label and catalog number, hip hop/metal/punk original pressings most valuable, chrome or metal tape formulation, limited releases or demo tapes, promo copies, original J-card in good condition, autographed J-cards, misprints or label errors.`
  };

  const categoryPrompt = CATEGORY_PROMPTS[category] || CATEGORY_PROMPTS.books;
  const ebayCategory = EBAY_CATEGORIES[category] || '99';

  // Simple in-memory cache for eBay lookups
  const cache = global._pickeriqCache = global._pickeriqCache || {};

  try {
    // Resize image to 1000px max for faster processing
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

For every item potentially worth over $20, assess value and provide a plain English location description so the user can find it on the shelf.

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

CRITICAL SORTING: Return items sorted highest value_tier first (high, then medium, then low). Within each tier sort by likely value descending.
what_to_check must only contain checks specific to THIS exact item.
value_range_estimate should be conservative and realistic.
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

    // Sort items: high > medium > low, then by estimated value within tier
    const tierOrder = { high: 0, medium: 1, low: 2 };
    items.sort((a, b) => {
      const tierDiff = (tierOrder[a.value_tier] || 2) - (tierOrder[b.value_tier] || 2);
      return tierDiff;
    });

    // Fetch eBay prices for each item in parallel with caching
    const itemsWithPrices = await Promise.all(
      items.map(async (item) => {
        try {
          const cacheKey = `${category}:${item.ebay_search_query || item.title}`;
          const cached = cache[cacheKey];
          const cacheAge = cached ? (Date.now() - cached.ts) : Infinity;

          // Use cache if less than 1 hour old
          if (cached && cacheAge < 3600000) {
            return { ...item, ebay_prices: cached.prices, ebay_search_url: buildEbayUrl(item, ebayCategory) };
          }

          const query = encodeURIComponent(item.ebay_search_query || `${item.title} ${item.artist_author}`);
          const ebayRes = await fetch(
            `https://svcs.ebay.com/services/search/FindingService/v1` +
            `?OPERATION-NAME=findCompletedItems` +
            `&SERVICE-VERSION=1.0.0` +
            `&SECURITY-APPNAME=${process.env.EBAY_APP_ID}` +
            `&RESPONSE-DATA-FORMAT=JSON` +
            `&keywords=${query}` +
            `&categoryId=${ebayCategory}` +
            `&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true` +
            `&sortOrder=EndTimeSoonest` +
            `&paginationInput.entriesPerPage=10`
          );

          const ebayData = await ebayRes.json();
          const soldItems = ebayData?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];

          if (soldItems.length === 0) {
            cache[cacheKey] = { prices: null, ts: Date.now() };
            return { ...item, ebay_prices: null, ebay_search_url: buildEbayUrl(item, ebayCategory) };
          }

          const prices = soldItems
            .map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__']))
            .filter(p => !isNaN(p) && p > 0)
            .sort((a, b) => a - b);

          const ebayPrices = {
            min: Math.round(prices[0]),
            max: Math.round(prices[prices.length - 1]),
            avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
            count: prices.length
          };

          cache[cacheKey] = { prices: ebayPrices, ts: Date.now() };

          return {
            ...item,
            ebay_prices: ebayPrices,
            ebay_search_url: buildEbayUrl(item, ebayCategory)
          };
        } catch (e) {
          return { ...item, ebay_prices: null, ebay_search_url: buildEbayUrl(item, ebayCategory) };
        }
      })
    );

    // Re-sort with eBay data: within same tier, sort by ebay avg descending
    const tierOrd = { high: 0, medium: 1, low: 2 };
    itemsWithPrices.sort((a, b) => {
      const tierDiff = (tierOrd[a.value_tier] || 2) - (tierOrd[b.value_tier] || 2);
      if (tierDiff !== 0) return tierDiff;
      const aVal = a.ebay_prices?.avg || 0;
      const bVal = b.ebay_prices?.avg || 0;
      return bVal - aVal;
    });

    return res.status(200).json({
      total_items_spotted: parsed.total_items_spotted,
      items: itemsWithPrices
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function buildEbayUrl(item, categoryId) {
  const q = encodeURIComponent(item.ebay_search_query || `${item.title} ${item.artist_author}`);
  return `https://www.ebay.com/sch/i.html?_nkw=${q}&_sacat=${categoryId}&LH_Complete=1&LH_Sold=1`;
}
