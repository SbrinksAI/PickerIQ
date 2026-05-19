export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  // Map coordinates to Craigslist subdomain
  const cities = [
    { sub: 'losangeles', minLat: 33.7, maxLat: 34.8, minLng: -118.95, maxLng: -117.6 },
    { sub: 'orangecounty', minLat: 33.4, maxLat: 33.95, minLng: -118.1, maxLng: -117.4 },
    { sub: 'sandiego', minLat: 32.5, maxLat: 33.5, minLng: -117.6, maxLng: -116.1 },
    { sub: 'inlandempire', minLat: 33.5, maxLat: 34.3, minLng: -117.7, maxLng: -115.5 },
    { sub: 'ventura', minLat: 34.1, maxLat: 34.9, minLng: -119.5, maxLng: -118.6 },
    { sub: 'sfbay', minLat: 37.2, maxLat: 38.0, minLng: -122.6, maxLng: -121.5 },
    { sub: 'seattle', minLat: 47.1, maxLat: 47.8, minLng: -122.5, maxLng: -121.7 },
    { sub: 'phoenix', minLat: 33.0, maxLat: 33.85, minLng: -113.0, maxLng: -111.6 },
    { sub: 'denver', minLat: 39.5, maxLat: 40.1, minLng: -105.2, maxLng: -104.6 },
    { sub: 'chicago', minLat: 41.4, maxLat: 42.2, minLng: -88.4, maxLng: -87.4 },
    { sub: 'houston', minLat: 29.4, maxLat: 30.3, minLng: -95.9, maxLng: -94.8 },
    { sub: 'dallas', minLat: 32.5, maxLat: 33.2, minLng: -97.2, maxLng: -96.4 },
    { sub: 'austin', minLat: 30.0, maxLat: 30.7, minLng: -98.2, maxLng: -97.4 },
    { sub: 'miami', minLat: 25.1, maxLat: 26.5, minLng: -80.9, maxLng: -80.0 },
    { sub: 'atlanta', minLat: 33.5, maxLat: 34.2, minLng: -84.8, maxLng: -84.0 },
    { sub: 'newyork', minLat: 40.4, maxLat: 41.0, minLng: -74.3, maxLng: -73.6 },
    { sub: 'portland', minLat: 45.3, maxLat: 45.7, minLng: -122.9, maxLng: -122.3 },
    { sub: 'minneapolis', minLat: 44.7, maxLat: 45.2, minLng: -93.6, maxLng: -92.8 },
    { sub: 'detroit', minLat: 42.1, maxLat: 42.7, minLng: -83.5, maxLng: -82.8 },
    { sub: 'boston', minLat: 42.2, maxLat: 42.6, minLng: -71.3, maxLng: -70.8 },
  ];

  let subdomain = 'losangeles';
  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);
  for (const c of cities) {
    if (userLat >= c.minLat && userLat <= c.maxLat && userLng >= c.minLng && userLng <= c.maxLng) {
      subdomain = c.sub;
      break;
    }
  }

  try {
    const rssUrl = `https://${subdomain}.craigslist.org/search/sss?query=garage+sale&format=rss&lat=${userLat}&lon=${userLng}&search_distance=15`;
    const rssRes = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PickerIQ/1.0)',
        'Accept': 'application/rss+xml, text/xml, */*'
      }
    });

    if (!rssRes.ok) {
      return res.status(200).json({ sales: [], error: `Craigslist returned ${rssRes.status}` });
    }

    const xml = await rssRes.text();

    // Parse items from RSS
    const items = [];
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

    for (const match of itemMatches) {
      const itemXml = match[1];

      const title = (itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                     itemXml.match(/<title>(.*?)<\/title>/))?.[1]?.trim() || '';
      const link = (itemXml.match(/<link>(.*?)<\/link>/) ||
                    itemXml.match(/<link\s*\/?>([^<]*)/s))?.[1]?.trim() || '';
      const description = (itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/s) ||
                           itemXml.match(/<description>(.*?)<\/description>/s))?.[1]?.trim() || '';
      const pubDate = itemXml.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() || '';

      // Extract coordinates from geo:lat/geo:long or dc:format
      const geoLat = itemXml.match(/<geo:lat>(.*?)<\/geo:lat>/)?.[1] ||
                     itemXml.match(/<latitude>(.*?)<\/latitude>/)?.[1];
      const geoLng = itemXml.match(/<geo:long>(.*?)<\/geo:long>/)?.[1] ||
                     itemXml.match(/<longitude>(.*?)<\/longitude>/)?.[1];

      if (title && geoLat && geoLng) {
        items.push({
          title,
          link,
          description: description.replace(/<[^>]*>/g, '').slice(0, 150),
          pubDate,
          lat: parseFloat(geoLat),
          lng: parseFloat(geoLng)
        });
      }
    }

    res.setHeader('Cache-Control', 's-maxage=1800'); // cache 30 mins
    return res.status(200).json({ sales: items, subdomain, count: items.length });

  } catch(err) {
    return res.status(200).json({ sales: [], error: err.message });
  }
}
