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

function detectSourceMarket(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    const path = new URL(value).pathname.toLowerCase();

    if (
      host === "www.amazon.ae" ||
      host === "amazon.ae" ||
      host.endsWith(".ae") ||
      (host.includes("noon.com") && (path.startsWith("/uae") || path.startsWith("/en-ae")))
    ) {
      return { route: "uae", currency: "AED" };
    }

    if (host === "www.amazon.co.uk" || host === "amazon.co.uk" || host.endsWith(".uk")) {
      return { route: "uk", currency: "GBP" };
    }

    if (
      host === "www.amazon.com" ||
      host === "amazon.com" ||
      host.includes("walmart.com") ||
      host.includes("target.com") ||
      host.includes("bestbuy.com") ||
      host.includes("ebay.com")
    ) {
      return { route: "usa", currency: "USD" };
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

function sourceMarketLabel(sourceMarket) {
  if (!sourceMarket) return "unknown marketplace";
  if (sourceMarket.route === "uae") return "UAE route (Amazon UAE / Noon UAE)";
  if (sourceMarket.route === "uk") return "UK route (Amazon UK)";
  if (sourceMarket.route === "usa") return "USA route (Amazon US)";
  return "source route";
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

function sanitizeQuote(raw, url) {
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

  return {
    order_ref: makeOrderRef(),
    source_url: url,
    name: String(raw.name || "Product quote").slice(0, 80),
    brand: raw.brand ? String(raw.brand).slice(0, 60) : null,
    model: raw.model ? String(raw.model).slice(0, 80) : null,
    weight_kg: weights.chargeable_weight_kg,
    chargeable_weight_kg: weights.chargeable_weight_kg,
    actual_weight_kg: weights.actual_weight_kg,
    volumetric_weight_kg: weights.volumetric_weight_kg,
    dimensions_cm: weights.dimensions_cm,
    uk: makeRoute(raw.uk, "GBP", "Amazon UK / UK retailer"),
    usa: makeRoute(raw.usa, "USD", "Amazon US / US retailer"),
    uae: makeRoute(raw.uae, "AED", "Amazon UAE / Noon UAE"),
    notes: raw.notes
      ? String(raw.notes).slice(0, 220)
      : "Live web lookup estimate. Final invoice confirmed before order."
  };
}

// Extract JSON from Claude's text response — Claude returns prose +
// a JSON block, so we find the first { ... } block in the output.
function extractJson(text) {
  // Try a fenced ```json block first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch (_) {}
  }
  // Fall back to finding the outermost { } block
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
  }
  return null;
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

  const sourceMarket = detectSourceMarket(url);
  const sourceAsin = extractAmazonAsin(url);
  const cacheKey = getCacheKey(url, sourceAsin);

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

  // ─── Prompt ───────────────────────────────────────────────────────────────────
  const sourceInstructions = sourceMarket
    ? `

CRITICAL SOURCE-MARKET RULE:
The pasted URL is from the ${sourceMarketLabel(sourceMarket)}.
Step 1 — Use the web_search tool to fetch the EXACT pasted URL: ${url}
Read the product name, brand, model, variant, and price directly from that page.
This is your authoritative ${sourceMarket.route.toUpperCase()} price in ${sourceMarket.currency}.
Do NOT substitute a different regional store for this route.
Step 2 — Using the product identity from Step 1, search the other two markets separately.
NEVER put USD pricing into the AED field. NEVER put USD pricing into the GBP field.`
    : "";

  const asinInstructions = sourceAsin
    ? `

Amazon ASIN: ${sourceAsin}
Use this ASIN across all three markets:
- UAE price: search amazon.ae for ASIN ${sourceAsin}
- UK price: search amazon.co.uk for ASIN ${sourceAsin}
- USA price: search amazon.com for ASIN ${sourceAsin}`
    : "";

  const prompt = `You are a product research assistant for On Trend, a Tanzania-based global shopping service. A client has pasted a product URL and needs a landed price quote.

Product URL: ${url}${sourceInstructions}${asinInstructions}

YOUR TASK:
1. Fetch the pasted URL using web_search to get the exact product details and source market price.
2. Search the other two markets for the same exact product.
3. Estimate packed shipping weight and dimensions for air freight to Tanzania.

Markets needed:
- UAE: amazon.ae or noon.com/uae — price in AED
- UK: amazon.co.uk — price in GBP  
- USA: amazon.com — price in USD

Cross-market rules:
- Match by brand + model + ASIN/SKU + exact variant (colour, size, storage).
- If a market has no exact match, set that route's price to null.
- Never substitute a different product to fill a route.
- One or two null routes is acceptable.

Weight rules:
- actual_weight_kg: real packed weight in kg.
- dimensions_cm: packed box length, width, height in cm.
- volumetric_weight_kg = length * width * height / 5000.
- chargeable_weight_kg = max(actual_weight_kg, volumetric_weight_kg).
- For bulky/light items (bags, shoes, toys, bedding, lamps) lean toward higher volumetric estimates.

IMPORTANT: After doing your research, respond with ONLY a single valid JSON object in this exact structure. No explanation before or after, just the JSON:

{
  "name": "exact product name max 80 chars",
  "brand": "brand name or null",
  "model": "model/SKU/ASIN/variant or null",
  "actual_weight_kg": 0.5,
  "dimensions_cm": { "length": 20, "width": 15, "height": 5 },
  "volumetric_weight_kg": 0.3,
  "chargeable_weight_kg": 0.5,
  "uk": {
    "price": 29.99,
    "currency": "GBP",
    "store": "Amazon UK",
    "matched_product_name": "exact title found",
    "product_url": "https://...",
    "confidence": "high"
  },
  "usa": {
    "price": 35.99,
    "currency": "USD",
    "store": "Amazon US",
    "matched_product_name": "exact title found",
    "product_url": "https://...",
    "confidence": "high"
  },
  "uae": {
    "price": 128.90,
    "currency": "AED",
    "store": "Amazon UAE",
    "matched_product_name": "exact title found",
    "product_url": "https://...",
    "confidence": "high"
  },
  "notes": "brief note about the quote"
}

Use null for price fields where no exact match was found. Do not quote weapons, alcohol, drugs, adult items, or unsafe products.`;

  // ─── Call Anthropic API ───────────────────────────────────────────────────────
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);

  let response, data;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 4000,
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 6
          }
        ],
        messages: [
          { role: "user", content: prompt }
        ]
      })
    });

    data = await response.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      return json(504, {
        error: "The quote lookup took too long. Please try again or send the link on WhatsApp."
      });
    }
    return json(500, { error: "Network error reaching Anthropic. Please try again." });
  }

  clearTimeout(timeout);

  if (!response.ok) {
    const message = data?.error?.message || "Anthropic API request failed.";
    console.error("Anthropic error:", JSON.stringify(data));
    return json(response.status >= 500 ? 502 : 400, { error: message });
  }

  // Extract the text content from Claude's response
  // Claude returns an array of content blocks — find the last text block
  const textBlock = (data.content || [])
    .filter(block => block.type === "text")
    .pop();

  if (!textBlock?.text) {
    console.error("No text block in Anthropic response:", JSON.stringify(data).slice(0, 500));
    return json(502, {
      error: "No quote data was returned. Please try another product link."
    });
  }

  const parsed = extractJson(textBlock.text);
  if (!parsed) {
    console.error("Could not parse JSON from Claude response:", textBlock.text.slice(0, 500));
    return json(502, { error: "The quote response could not be read. Please try again." });
  }

  const result = sanitizeQuote(parsed, url);
  const hasAnyPrice = [result.uk.price, result.usa.price, result.uae.price].some(Boolean);
  if (!hasAnyPrice) {
    return json(404, {
      error:
        "We could not find current prices for this product. Please send the link on WhatsApp for a manual quote."
    });
  }

  memoryCache.set(cacheKey, { createdAt: Date.now(), data: result });
  return json(200, result);
};
