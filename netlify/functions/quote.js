const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Bug 4 fix: cache is noted as best-effort only — it works within a warm
// Lambda container but is not relied upon for correctness.
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
  // Bug 3 fix: strip tracking/session query params that don't affect product
  // identity so the same product isn't cached multiple times.
  const KEEP_PARAMS = new Set(["th", "psc", "color", "size", "variant"]);
  const cleaned = new URLSearchParams();
  for (const [k, v] of parsed.searchParams.entries()) {
    if (KEEP_PARAMS.has(k.toLowerCase())) cleaned.set(k, v);
  }
  parsed.search = cleaned.toString();
  // Remove trailing slash for consistency
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

// Bug 3 fix: for Amazon URLs use the ASIN as the cache key so variant URLs
// for the same product share one cache entry.
function getCacheKey(url, asin) {
  if (asin) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return `asin:${host}:${asin}`;
    } catch (_) {}
  }
  return url;
}

// Bug 9 fix: noon.com detection is now path-aware to avoid matching
// non-UAE Noon storefronts (Saudi, Egypt).
function detectSourceMarket(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    const path = new URL(value).pathname.toLowerCase();

    // UAE
    if (
      host === "www.amazon.ae" ||
      host === "amazon.ae" ||
      host.endsWith(".ae") ||
      // Noon UAE — path starts with /uae/ or /en-ae/
      (host.includes("noon.com") && (path.startsWith("/uae") || path.startsWith("/en-ae")))
    ) {
      return { route: "uae", currency: "AED" };
    }

    // UK
    if (host === "www.amazon.co.uk" || host === "amazon.co.uk" || host.endsWith(".uk")) {
      return { route: "uk", currency: "GBP" };
    }

    // USA
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

// Bug 10 fix: only extract ASIN from known Amazon ASIN path patterns.
function extractAmazonAsin(value) {
  try {
    const path = new URL(value).pathname || "";
    // Only match /dp/ASIN or /gp/product/ASIN — not arbitrary 10-char segments
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

// Bug 2 fix: robust output extraction with fallback logging.
function getOutputText(data) {
  // Flat text field (some response shapes)
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  // Nested message content (standard /v1/responses shape)
  const fromOutput = (data.output || [])
    .filter(item => item.type === "message")
    .flatMap(item => item.content || [])
    .filter(c => c.type === "output_text" || c.type === "text")
    .map(c => c.text || "")
    .join("");

  if (fromOutput.trim()) return fromOutput;

  // Last resort: choices array (/v1/chat/completions shape)
  const fromChoices = (data.choices || [])
    .map(c => c.message?.content || "")
    .join("");

  return fromChoices;
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
    // Bug 6 fix: order_ref is always generated server-side — never from model.
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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(500, {
      error: "OpenAI API key is missing. Add OPENAI_API_KEY in Netlify environment variables."
    });
  }

  // ─── JSON schema ─────────────────────────────────────────────────────────────
  // Bug 7 fix: use anyOf instead of type arrays for strict mode compatibility.
  const nullable = type => ({ anyOf: [{ type }, { type: "null" }] });

  const routeSchema = currency => ({
    type: "object",
    additionalProperties: false,
    properties: {
      price: {
        ...nullable("number"),
        description: `Current price in ${currency} before shipping. Null if unavailable.`
      },
      currency: { type: "string", enum: [currency] },
      store: { type: "string" },
      matched_product_name: {
        ...nullable("string"),
        description: "Exact product title found for this market."
      },
      product_url: {
        ...nullable("string"),
        description: "URL of the matched product page."
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"]
      }
    },
    required: ["price", "currency", "store", "matched_product_name", "product_url", "confidence"]
  });

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "Exact product name, max 80 chars." },
      brand: { ...nullable("string"), description: "Brand if identifiable." },
      model: {
        ...nullable("string"),
        description: "Model, SKU, ASIN, colour/size variant if identifiable."
      },
      actual_weight_kg: {
        type: "number",
        description: "Actual packed weight in kg."
      },
      dimensions_cm: {
        type: "object",
        additionalProperties: false,
        properties: {
          length: { ...nullable("number"), description: "Packed length in cm." },
          width: { ...nullable("number"), description: "Packed width in cm." },
          height: { ...nullable("number"), description: "Packed height in cm." }
        },
        required: ["length", "width", "height"]
      },
      volumetric_weight_kg: {
        ...nullable("number"),
        description: "L*W*H/5000. Null if dimensions unavailable."
      },
      chargeable_weight_kg: {
        type: "number",
        description: "max(actual, volumetric). Used for shipping cost."
      },
      uk: routeSchema("GBP"),
      usa: routeSchema("USD"),
      uae: routeSchema("AED"),
      notes: { type: "string" }
    },
    required: [
      "name", "brand", "model",
      "actual_weight_kg", "dimensions_cm",
      "volumetric_weight_kg", "chargeable_weight_kg",
      "uk", "usa", "uae", "notes"
    ]
  };

  // ─── Prompt ───────────────────────────────────────────────────────────────────
  const sourceInstructions = sourceMarket
    ? `\n\nCRITICAL SOURCE-MARKET RULE:
The pasted URL is from the ${sourceMarketLabel(sourceMarket)}.
Step 1 — Open the EXACT pasted URL. Read the product name, brand, model, variant, and price directly from that page. This IS the ${sourceMarket.route.toUpperCase()} route price in ${sourceMarket.currency}. Do not search for a substitute or use a different regional store for this route.
Step 2 — Using the product identity from Step 1, separately search the other two markets.
NEVER put USD pricing into the AED field. NEVER put USD pricing into the GBP field. Each route must use its own regional store and currency.`
    : "";

  const asinInstructions = sourceAsin
    ? `\n\nAmazon ASIN: ${sourceAsin}. Use this as the primary product identifier across all three markets. On Amazon UAE use amazon.ae, on Amazon UK use amazon.co.uk, on Amazon US use amazon.com — always with this exact ASIN.`
    : "";

  const prompt = `You are a product research assistant for On Trend, a Tanzania-based global shopping service.

Product URL pasted by the client:
${url}${sourceInstructions}${asinInstructions}

Steps:
1. Open the pasted URL. Identify the EXACT product: title, brand, model/SKU/ASIN, colour, size, storage, pack size, variant.
2. Find the current price for that exact product in each market:
   - UAE: amazon.ae or noon.com/uae — price in AED
   - UK: amazon.co.uk — price in GBP
   - USA: amazon.com — price in USD
3. Estimate packed shipping weight and box dimensions for air freight.

Cross-market rules:
- Match by brand + model/SKU/ASIN + variant. Do not quote a different product.
- If a market has no exact match, return null for that route's price.
- A close official variant is acceptable at confidence "low" or "medium" only.
- One or two null routes is fine — never force a result.

Weight rules:
- actual_weight_kg: real packed weight in kg.
- dimensions_cm: packed box length, width, height in cm.
- volumetric_weight_kg = length * width * height / 5000.
- chargeable_weight_kg = max(actual, volumetric).
- For bulky/light items (bags, shoes, toys, bedding, lamps) lean toward higher volumetric.

Return only the structured JSON. No rates, markup, or fee breakdowns. Do not quote weapons, alcohol, drugs, adult items, gambling products, or unsafe products.`;

  // ─── Call OpenAI with a single AbortController covering the full request ──────
  // Bug 5 + 8 fix: one controller and timeout wraps fetch AND response.json().
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 42000);

  let response, data;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        // Bug 1 fix: correct tool name is "web_search_preview" not "web_search"
        tools: [{ type: "web_search_preview" }],
        tool_choice: "auto",
        input: prompt,
        text: {
          format: {
            type: "json_schema",
            name: "on_trend_quote_v7",
            strict: true,
            schema
          }
        }
      })
    });

    // Bug 8 fix: .json() is inside the try so the AbortController still covers it.
    data = await response.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      return json(504, {
        error: "The quote lookup took too long. Please try again or send the link on WhatsApp."
      });
    }
    return json(500, { error: "Network error reaching OpenAI. Please try again." });
  }

  clearTimeout(timeout);

  if (!response.ok) {
    const message = data?.error?.message || "OpenAI request failed.";
    return json(response.status >= 500 ? 502 : 400, { error: message });
  }

  const outputText = getOutputText(data).trim();
  if (!outputText) {
    return json(502, {
      error: "No quote data was returned. Please try another product link."
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (_) {
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
