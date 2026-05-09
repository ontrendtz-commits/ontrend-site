const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const memoryCache = new Map();

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function normalizeUrl(value) {
  const parsed = new URL(value.trim());
  parsed.hash = "";
  const KEEP_PARAMS = new Set(["th", "psc", "color", "size", "variant"]);
  const cleaned = new URLSearchParams();
  for (const [k, v] of parsed.searchParams.entries()) {
    if (KEEP_PARAMS.has(k.toLowerCase())) cleaned.set(k, v);
  }
  parsed.search = cleaned.toString();
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

function getCacheKey(url, asin) {
  if (asin) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return `asin:${host}:${asin}`;
    } catch (_) {}
  }
  return url;
}

function detectAmazonMarket(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    const path = new URL(value).pathname.toLowerCase();

    if (host === "www.amazon.ae" || host === "amazon.ae") {
      return { route: "uae", currency: "AED", store: "Amazon UAE", domain: "amazon.ae" };
    }
    if (host.includes("noon.com") && (path.startsWith("/uae") || path.startsWith("/en-ae"))) {
      return { route: "uae", currency: "AED", store: "Noon UAE", domain: "noon.com" };
    }
    if (host === "www.amazon.co.uk" || host === "amazon.co.uk") {
      return { route: "uk", currency: "GBP", store: "Amazon UK", domain: "amazon.co.uk" };
    }
    if (host === "www.amazon.com" || host === "amazon.com") {
      return { route: "usa", currency: "USD", store: "Amazon US", domain: "amazon.com" };
    }
    if (host.includes("walmart.com")) {
      return { route: "usa", currency: "USD", store: "Walmart US", domain: "walmart.com" };
    }
  } catch (_) {}
  return null;
}

function extractAmazonAsin(value) {
  try {
    const path = new URL(value).pathname || "";
    const match = path.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    return match ? match[1].toUpperCase() : null;
  } catch (_) {
    return null;
  }
}

// Extract the brand domain for non-Amazon links so Claude searches
// the right regional sites instead of defaulting to Amazon
function extractBrandInfo(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    // Strip www. and country subdomains to get the core brand domain
    const parts = host.replace(/^www\./, "").split(".");
    // e.g. charleskeith.co.uk -> charleskeith
    // e.g. zara.com -> zara
    const brand = parts[0];
    return { host, brand };
  } catch (_) {
    return null;
  }
}

function makeOrderRef() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const code = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `OT-${date}-${code}`;
}

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function calculateChargeableWeight(raw) {
  const actual = num(raw.actual_weight_kg, num(raw.weight_kg, 0.5));
  const dims = raw.dimensions_cm || {};
  const length = num(dims.length, null);
  const width = num(dims.width, null);
  const height = num(dims.height, null);
  const volumetric = length && width && height
    ? (length * width * height) / 5000
    : null;
  const chargeable = Math.max(actual || 0.5, volumetric || 0);
  return {
    actual_weight_kg: round2(Math.max(0.1, actual || 0.5)),
    volumetric_weight_kg: volumetric ? round2(Math.max(0.1, volumetric)) : null,
    chargeable_weight_kg: round2(Math.max(0.1, chargeable || 0.5)),
    dimensions_cm: {
      length: length ? round2(length) : null,
      width: width ? round2(width) : null,
      height: height ? round2(height) : null
    }
  };
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch (_) {}
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

async function fetchSingleQuote(url, market, asin, apiKey, signal) {
  const asinLine = asin
    ? `\nASIN: ${asin} — search for this exact ASIN on ${market.domain}.`
    : "";

  const prompt = `You are a product research assistant for On Trend, a Tanzania-based global shopping service.

The client has pasted this product URL:
${url}${asinLine}

TASK:
Use web_search to find the current live price of this exact product on ${market.store} (${market.domain}).
${asin ? `Search for ASIN ${asin} on ${market.domain} to get the exact current price.` : `Search for the product name and model on ${market.domain} to get the exact current price.`}

Rules:
- The price MUST be in ${market.currency} from ${market.domain} only.
- Do not use prices from any other website or region.
- Get the price that is currently shown on the product listing page right now.
- actual_weight_kg: real packed weight in kg.
- dimensions_cm: packed box dimensions in cm (length, width, height).
- volumetric_weight_kg = length * width * height / 5000.
- chargeable_weight_kg = max(actual_weight_kg, volumetric_weight_kg).

You MUST respond with ONLY a valid JSON object. No explanation, no markdown, no text before or after:

{
  "name": "exact product name max 80 chars",
  "brand": "brand or null",
  "model": "model/SKU/variant or null",
  "price": 128.90,
  "currency": "${market.currency}",
  "store": "${market.store}",
  "product_url": "url of the listing",
  "actual_weight_kg": 0.5,
  "dimensions_cm": { "length": 20, "width": 15, "height": 5 },
  "volumetric_weight_kg": 0.3,
  "chargeable_weight_kg": 0.5,
  "notes": "brief note"
}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    signal,
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("Anthropic API error:", JSON.stringify(data));
    throw new Error(data?.error?.message || "Anthropic API error");
  }

  console.log("Claude raw content blocks:", JSON.stringify(data.content).slice(0, 3000));

  const textBlock = (data.content || []).filter(b => b.type === "text").pop();
  if (!textBlock?.text) {
    console.error("No text block. Response:", JSON.stringify(data).slice(0, 1000));
    throw new Error("No text in response");
  }

  console.log("Claude text response:", textBlock.text.slice(0, 1000));

  const parsed = extractJson(textBlock.text);
  if (!parsed) {
    console.error("Could not extract JSON from:", textBlock.text.slice(0, 500));
    throw new Error("Could not parse JSON from response");
  }

  console.log("Parsed result:", JSON.stringify(parsed));

  if (!parsed.price || parsed.price <= 0) {
    console.error("No valid price:", JSON.stringify(parsed));
    throw new Error("Amazon prices aren't always visible online — send us the link on WhatsApp and we'll get you a quote manually.");
  }

  return parsed;
}

async function fetchComparisonQuote(url, apiKey, signal) {
  const brandInfo = extractBrandInfo(url);
  const brandName = brandInfo?.brand || "this brand";

  const prompt = `You are a product research assistant for On Trend, a Tanzania-based global shopping service.

The client has pasted this product URL from ${brandName}'s website:
${url}

TASK:
1. Search for this exact product on the pasted URL and identify: name, brand, model, SKU, variant (colour, size).
2. Find the current live price in each of these three markets. For each market, check the BRAND'S OWN WEBSITE first (e.g. charleskeith.com/ae, charleskeith.com/us, charleskeith.co.uk), then fall back to Amazon or other major retailers only if the brand has no regional site:
   - UAE price in AED — search "${brandName} UAE" or "${brandName} .ae" or the brand's UAE page
   - UK price in GBP — search "${brandName} UK" or the brand's .co.uk page (the pasted URL may already be the UK price)
   - USA price in USD — search "${brandName} US" or the brand's .com page
3. Estimate packed shipping weight and box dimensions.

Important rules:
- ALWAYS check the brand's own regional website before Amazon.
- The pasted URL is from the UK site — that IS the UK price, read it directly.
- For UAE and USA, find the same product on the brand's UAE and US pages.
- Match by exact SKU/model code and colour variant.
- If a market genuinely has no price, set price to null.
- Do not invent prices.

Weight rules:
- actual_weight_kg: real packed weight in kg.
- dimensions_cm: packed box in cm (length, width, height).
- volumetric_weight_kg = length * width * height / 5000.
- chargeable_weight_kg = max(actual_weight_kg, volumetric_weight_kg).

You MUST respond with ONLY a valid JSON object. No explanation, no markdown, no text before or after:

{
  "name": "exact product name max 80 chars",
  "brand": "brand or null",
  "model": "model/SKU/variant or null",
  "actual_weight_kg": 0.5,
  "dimensions_cm": { "length": 20, "width": 15, "height": 5 },
  "volumetric_weight_kg": 0.3,
  "chargeable_weight_kg": 0.5,
  "uk": {
    "price": 29.99,
    "currency": "GBP",
    "store": "Charles & Keith UK",
    "matched_product_name": "exact title",
    "product_url": "https://...",
    "confidence": "high"
  },
  "usa": {
    "price": 35.99,
    "currency": "USD",
    "store": "Charles & Keith US",
    "matched_product_name": "exact title",
    "product_url": "https://...",
    "confidence": "high"
  },
  "uae": {
    "price": 128.90,
    "currency": "AED",
    "store": "Charles & Keith UAE",
    "matched_product_name": "exact title",
    "product_url": "https://...",
    "confidence": "high"
  },
  "notes": "brief note"
}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    signal,
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
      max_tokens: 3000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("Anthropic API error:", JSON.stringify(data));
    throw new Error(data?.error?.message || "Anthropic API error");
  }

  console.log("Claude raw content blocks:", JSON.stringify(data.content).slice(0, 3000));

  const textBlock = (data.content || []).filter(b => b.type === "text").pop();
  if (!textBlock?.text) {
    console.error("No text block. Response:", JSON.stringify(data).slice(0, 1000));
    throw new Error("No text in response");
  }

  console.log("Claude text response:", textBlock.text.slice(0, 1000));

  const parsed = extractJson(textBlock.text);
  if (!parsed) {
    console.error("Could not extract JSON:", textBlock.text.slice(0, 500));
    throw new Error("Could not parse JSON from response");
  }

  console.log("Parsed result:", JSON.stringify(parsed));

  const hasAnyPrice = [parsed.uk?.price, parsed.usa?.price, parsed.uae?.price].some(Boolean);
  if (!hasAnyPrice) {
    console.error("No prices found:", JSON.stringify(parsed));
    throw new Error("No prices found");
  }

  return parsed;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let url;
  try {
    const body = JSON.parse(event.body || "{}");
    url = normalizeUrl(body.url || "");
  } catch (_) {
    return json(400, { error: "Please paste a valid product link." });
  }

  if (!isValidHttpUrl(url)) {
    return json(400, {
      error: "Please paste a valid product link starting with http:// or https://."
    });
  }

  const market = detectAmazonMarket(url);
  const asin = extractAmazonAsin(url);
  const cacheKey = getCacheKey(url, asin);
  const isSingleMode = !!market;

  console.log(`Mode: ${isSingleMode ? "single" : "comparison"} | Market: ${market?.route || "none"} | ASIN: ${asin || "none"} | URL: ${url}`);

  const cached = memoryCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return json(200, { ...cached.data, cached: true });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, {
      error: "Anthropic API key is missing. Add ANTHROPIC_API_KEY in Netlify environment variables."
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);

  try {
    const orderRef = makeOrderRef();

    if (isSingleMode) {
      const raw = await fetchSingleQuote(url, market, asin, apiKey, controller.signal);
      const weights = calculateChargeableWeight(raw);

      const result = {
        mode: "single",
        order_ref: orderRef,
        source_url: url,
        name: String(raw.name || "Product").slice(0, 80),
        brand: raw.brand ? String(raw.brand).slice(0, 60) : null,
        model: raw.model ? String(raw.model).slice(0, 80) : null,
        weight_kg: weights.chargeable_weight_kg,
        chargeable_weight_kg: weights.chargeable_weight_kg,
        actual_weight_kg: weights.actual_weight_kg,
        volumetric_weight_kg: weights.volumetric_weight_kg,
        dimensions_cm: weights.dimensions_cm,
        route: {
          market: market.route,
          price: Number(raw.price.toFixed(2)),
          currency: market.currency,
          store: market.store,
          product_url: raw.product_url || url
        },
        notes: raw.notes || "Live web lookup estimate. Final invoice confirmed before order."
      };

      clearTimeout(timeout);
      memoryCache.set(cacheKey, { createdAt: Date.now(), data: result });
      return json(200, result);

    } else {
      const raw = await fetchComparisonQuote(url, apiKey, controller.signal);
      const weights = calculateChargeableWeight(raw);

      const makeRoute = (entry, currency, defaultStore) => ({
        price: typeof entry?.price === "number" && entry.price > 0
          ? Number(entry.price.toFixed(2))
          : null,
        currency,
        store: entry?.store || defaultStore,
        matched_product_name: entry?.matched_product_name
          ? String(entry.matched_product_name).slice(0, 100)
          : null,
        product_url: entry?.product_url
          ? String(entry.product_url).slice(0, 500)
          : null,
        confidence: ["high", "medium", "low"].includes(entry?.confidence)
          ? entry.confidence
          : "medium"
      });

      const result = {
        mode: "comparison",
        order_ref: orderRef,
        source_url: url,
        name: String(raw.name || "Product").slice(0, 80),
        brand: raw.brand ? String(raw.brand).slice(0, 60) : null,
        model: raw.model ? String(raw.model).slice(0, 80) : null,
        weight_kg: weights.chargeable_weight_kg,
        chargeable_weight_kg: weights.chargeable_weight_kg,
        actual_weight_kg: weights.actual_weight_kg,
        volumetric_weight_kg: weights.volumetric_weight_kg,
        dimensions_cm: weights.dimensions_cm,
        uk: makeRoute(raw.uk, "GBP", "UK retailer"),
        usa: makeRoute(raw.usa, "USD", "US retailer"),
        uae: makeRoute(raw.uae, "AED", "UAE retailer"),
        notes: raw.notes || "Live web lookup estimate. Final invoice confirmed before order."
      };

      clearTimeout(timeout);
      memoryCache.set(cacheKey, { createdAt: Date.now(), data: result });
      return json(200, result);
    }

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      return json(504, {
        error: "The quote lookup took too long. Please try again or send the link on WhatsApp."
      });
    }
    console.error("Quote error:", err.message);
    return json(500, {
      error: "We could not complete this quote. Please try again or send the link on WhatsApp."
    });
  }
};
