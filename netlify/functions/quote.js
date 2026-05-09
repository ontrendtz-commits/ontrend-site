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
  const KEEP_PARAMS = new Set(["th", "psc", "color", "colour", "size", "variant", "dwvar"]);
  const cleaned = new URLSearchParams();
  for (const [k, v] of parsed.searchParams.entries()) {
    if (KEEP_PARAMS.has(k.toLowerCase())) cleaned.set(k, v);
  }
  parsed.search = cleaned.toString();
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

function getCacheKey(url) {
  try {
    const u = new URL(url);
    // For Amazon URLs use ASIN as cache key
    const asinMatch = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    if (asinMatch) return `asin:${u.hostname.toLowerCase()}:${asinMatch[1].toUpperCase()}`;
  } catch (_) {}
  return url;
}

// Detect the market and currency from the URL
// Returns { route, currency, store, domain, flag, delivery }
// Defaults to USA/USD if region is ambiguous
function detectMarket(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    const path = new URL(value).pathname.toLowerCase();

    // ── Amazon ──────────────────────────────────────────────────────────────
    if (host === "www.amazon.ae" || host === "amazon.ae") {
      return { route: "uae", currency: "AED", store: "Amazon UAE", flag: "🇦🇪", delivery: "5–7 working days" };
    }
    if (host === "www.amazon.co.uk" || host === "amazon.co.uk") {
      return { route: "uk", currency: "GBP", store: "Amazon UK", flag: "🇬🇧", delivery: "2–3 weeks" };
    }
    if (host === "www.amazon.com" || host === "amazon.com") {
      return { route: "usa", currency: "USD", store: "Amazon US", flag: "🇺🇸", delivery: "Approx. 1 month" };
    }

    // ── Noon ────────────────────────────────────────────────────────────────
    if (host.includes("noon.com") && (path.startsWith("/uae") || path.startsWith("/en-ae"))) {
      return { route: "uae", currency: "AED", store: "Noon UAE", flag: "🇦🇪", delivery: "5–7 working days" };
    }

    // ── UK domains (.co.uk or /gb/ or /en-gb/ in path) ───────────────────
    if (
      host.endsWith(".co.uk") ||
      path.includes("/en-gb/") ||
      path.includes("/gb/") ||
      path.startsWith("/gb")
    ) {
      return { route: "uk", currency: "GBP", store: host.replace("www.", ""), flag: "🇬🇧", delivery: "2–3 weeks" };
    }

    // ── UAE domains (.ae or /ae/ or /en-ae/ in path) ─────────────────────
    if (
      host.endsWith(".ae") ||
      path.includes("/en-ae/") ||
      path.includes("/ae/") ||
      path.startsWith("/ae")
    ) {
      return { route: "uae", currency: "AED", store: host.replace("www.", ""), flag: "🇦🇪", delivery: "5–7 working days" };
    }

    // ── Known US-only or ambiguous brand sites → default USA ─────────────
    // (michaelkors.com, stanley1913.com, coach.com, etc. all serve USD
    //  unless a regional path/subdomain is detected above)
    return {
      route: "usa",
      currency: "USD",
      store: host.replace("www.", ""),
      flag: "🇺🇸",
      delivery: "Approx. 1 month"
    };

  } catch (_) {
    return { route: "usa", currency: "USD", store: "US retailer", flag: "🇺🇸", delivery: "Approx. 1 month" };
  }
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

async function fetchQuote(url, market, asin, apiKey, signal) {
  const asinLine = asin
    ? `\nASIN: ${asin} — use this to find the exact listing on ${market.store}.`
    : "";

  const isAmazon = url.includes("amazon.");

  const amazonNote = isAmazon
    ? `\nNOTE: This is an Amazon link. Amazon sometimes hides prices until items are added to cart. If the price is hidden, say so clearly in your response by setting price to null and explaining in notes.`
    : "";

  const prompt = `You are a product research assistant for On Trend, a Tanzania-based global shopping service.

The client has pasted this product URL:
${url}${asinLine}${amazonNote}

TASK:
Search for this exact product and find its current live price.

Market detected from the URL: ${market.store} — price must be in ${market.currency}.
${asin ? `Search for ASIN ${asin} on ${market.store} to get the exact current price in ${market.currency}.` : `Search for the product on ${market.store} to get the exact current price in ${market.currency}.`}

Rules:
- The price MUST be in ${market.currency} only — do not convert or use a different currency.
- Do not use prices from a different region or website than ${market.store}.
- Get the actual current SELLING price shown on the product listing right now — this is the price the customer pays at checkout.
- If there is a sale price or discounted price, use that — NOT the original crossed-out price.
- Never use the "was" price, "compare at" price, or any struck-through price.
- If the price is genuinely unavailable (hidden, out of stock, requires login), set price to null.
- actual_weight_kg: real packed weight in kg — estimate from product specs or category norms.
- dimensions_cm: packed box dimensions in cm (length, width, height).
- volumetric_weight_kg = length * width * height / 5000.
- chargeable_weight_kg = max(actual_weight_kg, volumetric_weight_kg).
- For bags, shoes, clothing: estimate generously for packaging.

You MUST respond with ONLY a valid JSON object. No explanation, no markdown, no text before or after:

{
  "name": "exact product name max 80 chars",
  "brand": "brand or null",
  "model": "model/SKU/variant or null",
  "price": 45.00,
  "currency": "${market.currency}",
  "store": "${market.store}",
  "product_url": "url of the listing",
  "actual_weight_kg": 0.5,
  "dimensions_cm": { "length": 20, "width": 15, "height": 5 },
  "volumetric_weight_kg": 0.3,
  "chargeable_weight_kg": 0.5,
  "notes": "brief note about the product or pricing"
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
    // Check if Amazon hid the price
    const notes = (parsed.notes || "").toLowerCase();
    if (
      isAmazon &&
      (notes.includes("add to cart") || notes.includes("hidden") || notes.includes("cart"))
    ) {
      throw new Error(
        "Amazon prices aren't always visible online — send us the link on WhatsApp and we'll get you a quote manually."
      );
    }
    throw new Error(
      "We couldn't find a price for this product. Please send us the link on WhatsApp and we'll quote you manually."
    );
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

  const market = detectMarket(url);
  const asin = extractAmazonAsin(url);
  const cacheKey = getCacheKey(url);

  console.log(`Market: ${market.route} | Currency: ${market.currency} | Store: ${market.store} | ASIN: ${asin || "none"} | URL: ${url}`);

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
    const raw = await fetchQuote(url, market, asin, apiKey, controller.signal);
    clearTimeout(timeout);

    const weights = calculateChargeableWeight(raw);

    const result = {
      mode: "single",
      order_ref: makeOrderRef(),
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
        store: raw.store || market.store,
        product_url: raw.product_url || url,
        flag: market.flag,
        delivery: market.delivery
      },
      notes: raw.notes || "Live web lookup estimate. Final invoice confirmed before order."
    };

    memoryCache.set(cacheKey, { createdAt: Date.now(), data: result });
    return json(200, result);

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      return json(504, {
        error: "The quote lookup took too long. Please try again or send the link on WhatsApp."
      });
    }
    console.error("Quote error:", err.message);
    return json(500, { error: err.message });
  }
};
