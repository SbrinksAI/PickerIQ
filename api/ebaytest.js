// api/ebaytest.js — Finding API diagnostic for sold comps
// Hit this endpoint with ?q=YOUR+QUERY to see exactly what eBay returns

export default async function handler(req, res) {
  // Allow query override via URL, default to the known-failing case
  const query = req.query.q || 'Behold a Pale Horse Cooper';

  const appId = process.env.EBAY_APP_ID;

  if (!appId) {
    return res.status(500).json({
      error: 'EBAY_APP_ID not set in environment variables',
    });
  }

  // Build the Finding API URL exactly as scan.js does
  const endpoint = 'https://svcs.ebay.com/services/search/FindingService/v1';
  const params = new URLSearchParams({
    'OPERATION-NAME': 'findCompletedItems',
    'SERVICE-VERSION': '1.13.0',
    'SECURITY-APPNAME': appId,
    'RESPONSE-DATA-FORMAT': 'JSON',
    'REST-PAYLOAD': '',
    'keywords': query,
    'itemFilter(0).name': 'SoldItemsOnly',
    'itemFilter(0).value': 'true',
    'paginationInput.entriesPerPage': '10',
  });

  const url = `${endpoint}?${params.toString()}`;

  const diagnostic = {
    query_used: query,
    request_url: url,
    timestamp: new Date().toISOString(),
  };

  try {
    const response = await fetch(url);
    const status = response.status;
    const statusText = response.statusText;
    const rawText = await response.text();

    diagnostic.http_status = status;
    diagnostic.http_status_text = statusText;
    diagnostic.raw_response_length = rawText.length;

    // Try to parse as JSON
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      diagnostic.parse_error = parseErr.message;
      diagnostic.raw_response_preview = rawText.substring(0, 1000);
      return res.status(200).json(diagnostic);
    }

    // Drill into the eBay response structure
    const findResponse = parsed?.findCompletedItemsResponse?.[0];

    if (!findResponse) {
      diagnostic.problem = 'No findCompletedItemsResponse in payload';
      diagnostic.full_response = parsed;
      return res.status(200).json(diagnostic);
    }

    // eBay's ack field tells us success/failure
    diagnostic.ebay_ack = findResponse.ack?.[0];
    diagnostic.ebay_version = findResponse.version?.[0];
    diagnostic.ebay_timestamp = findResponse.timestamp?.[0];

    // Check for errors eBay returned
    if (findResponse.errorMessage) {
      diagnostic.ebay_errors = findResponse.errorMessage;
    }

    // Check the search result count
    const searchResult = findResponse.searchResult?.[0];
    diagnostic.result_count = searchResult?.['@count'] || '0';

    // If we got items, show first 3 with title and sold price
    if (searchResult?.item) {
      diagnostic.sample_items = searchResult.item.slice(0, 3).map((item) => ({
        title: item.title?.[0],
        sold_price: item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__,
        currency: item.sellingStatus?.[0]?.currentPrice?.[0]?.['@currencyId'],
        end_time: item.listingInfo?.[0]?.endTime?.[0],
        url: item.viewItemURL?.[0],
      }));
    }

    // Pagination info
    const pagination = findResponse.paginationOutput?.[0];
    if (pagination) {
      diagnostic.pagination = {
        total_entries: pagination.totalEntries?.[0],
        total_pages: pagination.totalPages?.[0],
      };
    }

    return res.status(200).json(diagnostic);
  } catch (err) {
    diagnostic.fetch_error = err.message;
    diagnostic.error_stack = err.stack;
    return res.status(500).json(diagnostic);
  }
}
