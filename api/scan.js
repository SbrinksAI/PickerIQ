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
    toys:       '220',
    videogames: '1249',
    sportscards:'212',
    books:      '267',
    bluray:     '617',
    cds:        '176984',
    vhs:        '309',
    cassettes:  '176983'
  };

  const CATEGORY_PROMPTS = {
    toys: `You are an expert toy and action figure reseller with 30 years of estate sale experience.
Identify every toy, action figure, diecast, or collectible figure visible.
For each item assess if it could be worth over $20.
Key value factors:
- Mint on Card (MOC) or Mint in Box (MIB) — sealed packaging multiplies value dramatically
- First run / year 1 production markings on packaging or figure
- Exact product line (vintage vs modern — e.g. vintage Star Wars vs new)
- Country of manufacture stamp (Hong Kong = older = more valuable)
- Factory errors or color variants
- All original accessories present for loose figures
- Retailer exclusives marked on packaging
- Major lines: Star Wars, GI Joe, He-Man, Transformers, TMNT, Marvel, DC`,

    videogames: `You are an expert video game reseller with 30 years of estate sale experience.
Identify every video game, console, or gaming accessory visible.
For each item assess if it could be worth over $20.
Key value factors:
- Complete in Box (CIB) — game, case, AND manual all present is critical
- Black label original release vs Greatest Hits (red label PS1/PS2) — original always worth more
- Sealed with shrinkwrap still intact adds massive premium
- First print variants — check back of case
- All inserts, registration cards, maps still inside
- Region — NTSC vs PAL vs Japanese import
- Limited or Collector editions
- Platform matters — same game worth $5 on one platform, $200 on another
- Key platforms: PS1, PS2, GameCube, N64, Dreamcast, Saturn most valuable`,

    sportscards: `You are an expert sports card and trading card reseller with 30 years of estate sale experience.
Identify every sports card, Pokemon card, or trading card visible.
For each item assess if it could be worth over $20.
Key value factors:
- Exact set name and year — critical for value
- Rookie cards (RC) always command premium
- Card condition — corners, edges, surface scratches, centering
- Parallel versions — holographic, refractor, foil, serial numbered
- Autograph or patch/relic cards embedded
- Print run number printed on card (e.g. /25, /10, /1)
- For Pokemon: first edition stamp bottom left of art box
- Shadowless vs shadow border early Pokemon
- Error cards — misprint, wrong back, wrong name
- Already graded cards in PSA/BGS/CGC slabs`,

    books: `You are an expert rare book reseller with 30 years of estate sale experience.
Identify every book visible and assess if it could be worth over $20.
Key value factors:
- First edition / first printing statement on copyright page
- Number line ending in 1 confirms first printing
- Author signature on title page
- Dust jacket presence and condition — jacket often worth more than book
- Publisher and imprint — some more collectible than others
- Advance Reader Copies (ARC) or uncorrected proofs
- Limitation statement on numbered editions
- Book club editions (no price on jacket flap, blind stamp on back) are LESS valuable
- Inscriptions or bookplates can add or subtract value`,

    bluray: `You are an expert Blu-ray and DVD reseller with 30 years of estate sale experience.
Identify every Blu-ray and DVD visible and assess if it could be worth over $20.
Key value factors:
- Out of print status — if no longer manufactured values spike significantly
- Limited Edition, Steelbook, or Collector packaging
- Criterion Collection releases — consistently valuable
- Region coding — certain Region B or region free releases command premiums
- Sealed shrinkwrap still intact
- All extras present — slipcovers, booklets, art cards
- Retailer exclusives (Target, Best Buy exclusive releases)
- Foreign releases of films never released domestically
- First pressing vs later reissues`,

    cds: `You are an expert music CD reseller with 30 years of estate sale experience.
Identify every CD visible and assess if it could be worth over $20.
Key value factors:
- Original pressing vs reissue — check catalog number on disc
- Promo copies marked Not For Sale or Promotional Use Only
- Japanese imports with OBI strip (paper band around case) — adds significant value
- Limited edition or numbered releases
- Catalog number format identifies pressing country and era
- Colored or picture discs
- All original inserts and lyric booklets present
- HDCD, SACD, or audiophile format releases
- Autographed inserts`,

    vhs: `You are an expert VHS tape reseller with 30 years of estate sale experience.
Identify every VHS tape visible and assess if it could be worth over $20.
Key value factors:
- Sealed shrinkwrap — sealed VHS commands enormous premium
- Big box releases (oversized rental store cases from early 1980s)
- Disney Black Diamond edition (small diamond with The Classics on spine)
- First release before reissues or re-ratings
- Horror, cult, and exploitation titles — most valuable VHS category
- Ex-rental copies vs retail — rental copies worth less
- Slipcovers or special packaging still present
- Watermark or clamshell cases vs cardboard sleeves
- UK PAL releases of certain films`,

    cassettes: `You are an expert cassette tape reseller with 30 years of estate sale experience.
Identify every cassette tape visible and assess if it could be worth over $20.
Key value factors:
- Sealed cassettes worth multiples of open ones
- Original pressing vs reissue — check label and catalog number
- Genre matters enormously — hip hop, metal, and punk original pressings most valuable
- Chrome or metal tape formulation on high end releases
- Limited releases or demo tapes
- Promo copies
- Original J-card (paper insert) in good condition
- Autographed J-cards
- Misprints or label errors`
  };

  const categoryPrompt = CATEGORY_PROMPTS[category] || CATEGORY_PROMPTS.books;
  const ebayCategory = EBAY_CATEGORIES[category] || '99';

  try {
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

For every item you identify that could be worth over $20, return details including bounding box coordinates so the item can be highlighted in the original image.

Return ONLY a raw JSON object — no markdown, no backticks, no extra text:
{
  "total_items_spotted": NUMBER,
  "items": [
    {
      "title": "exact title or name",
      "artist_author": "artist, author, or manufacturer",
      "value_tier": "high|medium|low",
      "reason": "1-2 sentences on why this specific item could be valuable",
      "what_to_check": ["specific check that applies to THIS item only — not generic"],
      "tags": ["relevant tags"],
      "ebay_search_query": "optimized search string for eBay",
      "bbox": {
        "x_percent": 0-100,
        "y_percent": 0-100,
        "width_percent": 0-100,
        "height_percent": 0-100
      }
    }
  ]
}

bbox values are percentages of image dimensions — x_percent and y_percent are the top-left corner.
Only include items potentially worth over $20. Rank highest to lowest value tier.
The what_to_check array must only contain checks that specifically apply to this exact item — never generic advice.
If nothing readable or identifiable: {"total_items_spotted":0,"items":[]}`,
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
      return res.status(500).json({ error: 'Claude API error: ' + err.slice(0, 300) });
    }

    const claudeData = await claudeRes.json();
    const raw = claudeData.content.map(b => b.text || '').join('');
    const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
    if (first === -1) return res.status(500).json({ error: 'No JSON returned. Got: ' + raw.slice(0, 200) });

    const parsed = JSON.parse(raw.slice(first, last + 1));
    const items = parsed.items || [];

    const itemsWithPrices = await Promise.all(
      items.map(async (item) => {
        try {
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
            return { ...item, ebay_prices: null, ebay_search_url: buildEbayUrl(item, ebayCategory) };
          }

          const prices = soldItems
            .map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__']))
            .filter(p => !isNaN(p) && p > 0)
            .sort((a, b) => a - b);

          return {
            ...item,
            ebay_prices: {
              min: Math.round(prices[0]),
              max: Math.round(prices[prices.length - 1]),
              avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
              count: prices.length
            },
            ebay_search_url: buildEbayUrl(item, ebayCategory)
          };
        } catch (e) {
          return { ...item, ebay_prices: null, ebay_search_url: buildEbayUrl(item, ebayCategory) };
        }
      })
    );

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
