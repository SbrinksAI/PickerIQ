export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { images, category } = req.body;
  if (!images || !Array.isArray(images) || images.length === 0) return res.status(400).json({ error: 'No images provided' });
  if (!category) return res.status(400).json({ error: 'No category provided' });

  const CATEGORY_PROMPTS = {
    books: `You are an expert rare book reseller. Identify valuable books — first editions, signed copies, rare prints, collectible authors.`,
    bluray: `You are an expert Blu-ray and DVD reseller. Identify valuable discs — OOP, Criterion, Steelbooks, limited editions.`,
    cds: `You are an expert music CD reseller. Identify valuable CDs — original pressings, OBI strips, promos, limited editions.`,
    vhs: `You are an expert VHS reseller. Identify valuable tapes — sealed, big box, Disney Black Diamond, horror/cult titles.`,
    cassettes: `You are an expert cassette reseller. Identify valuable tapes — sealed, hip hop/metal/punk originals, promo copies.`,
    videogames: `You are an expert video game reseller. Identify valuable games — black label originals, CIB, sealed, rare platforms.`,
    toys: `You are an expert toy reseller. Identify valuable toys — MOC/MIB, vintage Star Wars/GI Joe/Transformers/TMNT, first run.`,
    sportscards: `You are an expert sports card reseller. Identify valuable cards — rookies, parallels, first editions, graded slabs.`,
    vinyl: `You are an expert vinyl record reseller. Identify valuable records — original pressings on key labels (Blue Note, Prestige, Sun, Chess), colored vinyl, promos, audiophile editions, sealed copies, jazz/blues/punk/hip hop originals.`,
    comics: `You are an expert comic book reseller. Identify valuable comics — key issues (first appearances, origins, deaths), graded slabs, silver/bronze age, newsstand editions. Always include is_key_issue: true for key issues.`
  };

  const categoryPrompt = CATEGORY_PROMPTS[category] || CATEGORY_PROMPTS.books;

  try {
    // Build content array with all images + one instruction
    const imageContent = images.map((b64, i) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: b64 }
    }));

    imageContent.push({
      type: 'text',
      text: `Analyze each of the ${images.length} images above separately. Each image shows a single item or small group of items.

For each image return a separate JSON result object.

Return ONLY a raw JSON array with ${images.length} elements — one per image in order:
[
  {
    "total_items_spotted": NUMBER,
    "items": [
      {
        "title": "exact title",
        "artist_author": "artist or author",
        "value_tier": "high|medium|low",
        "reason": "1-2 sentences why valuable",
        "what_to_check": ["specific check for THIS item"],
        "ebay_search_query": "title and artist only, max 4 words, no descriptors",
        "location_description": "brief description of the item appearance"
      }
    ]
  }
]

Tier rules:
- high = High Potential Value: strong collector demand, known valuable title, sealed, rare
- medium = Medium Potential Value: some collector interest, common valuable title
- low = Low Potential Value: marginal interest, worth a quick check

If an image shows nothing valuable: {"total_items_spotted":0,"items":[]}
No markdown, no backticks, just the raw JSON array.`
    });

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
        system: categoryPrompt,
        messages: [{ role: 'user', content: imageContent }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      if (err.includes('overloaded')) return res.status(503).json({ error: 'overloaded' });
      return res.status(500).json({ error: 'Claude API error: ' + err.slice(0, 300) });
    }

    const claudeData = await claudeRes.json();
    const raw = claudeData.content.map(b => b.text || '').join('');
    const firstBracket = raw.indexOf('[');
    const lastBracket = raw.lastIndexOf(']');
    if (firstBracket === -1) return res.status(500).json({ error: 'No JSON array returned' });

    const parsed = JSON.parse(raw.slice(firstBracket, lastBracket + 1));

    // Add eBay search URLs
    const EBAY_CAT_IDS = {
      books: '267', bluray: '617', cds: '176984', vhs: '309',
      cassettes: '176983', videogames: '1249', toys: '220', sportscards: '212', vinyl: '176985', comics: '259104'
    };
    const catId = EBAY_CAT_IDS[category] || '267';

    const results = parsed.map(scan => ({
      ...scan,
      items: (scan.items || []).map(item => ({
        ...item,
        ebay_search_url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(item.ebay_search_query || item.title)}&_sacat=${catId}&LH_Complete=1&LH_Sold=1`
      }))
    }));

    return res.status(200).json(results);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
