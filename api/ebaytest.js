export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const query = encodeURIComponent('Harry Potter Philosophers Stone first edition');
  const categoryId = '267';
  
  const url = `https://svcs.ebay.com/services/search/FindingService/v1` +
    `?OPERATION-NAME=findCompletedItems` +
    `&SERVICE-VERSION=1.0.0` +
    `&SECURITY-APPNAME=${process.env.EBAY_APP_ID}` +
    `&RESPONSE-DATA-FORMAT=JSON` +
    `&keywords=${query}` +
    `&categoryId=${categoryId}` +
    `&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true` +
    `&sortOrder=EndTimeSoonest` +
    `&paginationInput.entriesPerPage=5`;

  try {
    const ebayRes = await fetch(url);
    const text = await ebayRes.text();
    
    let parsed;
    try { parsed = JSON.parse(text); } catch(e) { parsed = null; }
    
    const items = parsed?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
    const ack = parsed?.findCompletedItemsResponse?.[0]?.ack?.[0];
    const errorMessage = parsed?.findCompletedItemsResponse?.[0]?.errorMessage;

    res.status(200).json({
      status: ebayRes.status,
      ack,
      items_found: items.length,
      error_message: errorMessage || null,
      first_item: items[0] || null,
      raw_preview: text.slice(0, 500)
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}
