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
  return parsed.toString();
}

function makeOrderRef() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const code = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `OT-${date}-${code}`;
}

function getOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;

  return (data.output || [])
    .filter(item => item.type === "message")
    .flatMap(item => item.content || [])
    .filter(content => content.type === "output_text" || content.type === "text")
    .map(content => content.text || "")
    .join("");
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

  // Air freight volumetric weight. Use 5000 as a conservative divisor.
  // Formula: length(cm) * width(cm) * height(cm) / 5000.
  const volumetric = length && width && height ? (length * width * height) / 5000 : null;
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

  const route = (entry, currency, store) => ({
    price: typeof entry?.price === "number" && entry.price > 0 ? Number(entry.price.toFixed(2)) : null,
    currency,
    store: entry?.store || store,
    matched_product_name: entry?.matched_product_name ? String(entry.matched_product_name).slice(0, 100) : null,
    product_url: entry?.product_url ? String(entry.product_url).slice(0, 500) : null,
    confidence: ["high", "medium", "low"].includes(entry?.confidence) ? entry.confidence : "medium"
  });

  return {
    order_ref: raw.order_ref || makeOrderRef(),
    source_url: url,
    name: String(raw.name || "Product quote").slice(0, 80),
    brand: raw.brand ? String(raw.brand).slice(0, 60) : null,
    model: raw.model ? String(raw.model).slice(0, 80) : null,

    // Keep weight_kg for the existing frontend. It now means chargeable shipping weight.
    weight_kg: weights.chargeable_weight_kg,
    chargeable_weight_kg: weights.chargeable_weight_kg,
    actual_weight_kg: weights.actual_weight_kg,
    volumetric_weight_kg: weights.volumetric_weight_kg,
    dimensions_cm: weights.dimensions_cm,

    uk: route(raw.uk, "GBP", "Amazon UK / UK retailer"),
    usa: route(raw.usa, "USD", "Amazon US / US retailer"),
    uae: route(raw.uae, "AED", "Noon / UAE retailer"),
    notes: raw.notes ? String(raw.notes).slice(0, 220) : "Live web lookup estimate. Final invoice confirmed before order."
  };
}

exports.handler = async function(event) {
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
    return json(400, { error: "Please paste a valid product link starting with http:// or https://." });
  }

  const cached = memoryCache.get(url);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return json(200, { ...cached.data, cached: true });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(500, { error: "OpenAI API key is missing. Add OPENAI_API_KEY in Netlify environment variables." });
  }

  const routeSchema = (currency) => ({
    type: "object",
    additionalProperties: false,
    properties: {
      price: { type: ["number", "null"], description: `Current product price before shipping, in ${currency}. Null if no exact/close match is found.` },
      currency: { type: "string", enum: [currency] },
      store: { type: "string" },
      matched_product_name: { type: ["string", "null"], description: "The exact product title found for this market." },
      product_url: { type: ["string", "null"], description: "URL of the matched product page if found." },
      confidence: { type: "string", enum: ["high", "medium", "low"], description: "Confidence that this is the same product/model as the pasted URL." }
    },
    required: ["price", "currency", "store", "matched_product_name", "product_url", "confidence"]
  });

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "Exact product name from pasted URL, max 80 characters." },
      brand: { type: ["string", "null"], description: "Brand if identifiable." },
      model: { type: ["string", "null"], description: "Model, SKU, ASIN, color/size variant, or other identifier if identifiable." },
      actual_weight_kg: { type: "number", description: "Actual packed shipping weight in kg. Estimate if exact data is unavailable." },
      dimensions_cm: {
        type: "object",
        additionalProperties: false,
        properties: {
          length: { type: ["number", "null"], description: "Packed length in cm." },
          width: { type: ["number", "null"], description: "Packed width in cm." },
          height: { type: ["number", "null"], description: "Packed height in cm." }
        },
        required: ["length", "width", "height"]
      },
      volumetric_weight_kg: { type: ["number", "null"], description: "Packed volumetric weight using L*W*H/5000. Null only if dimensions are unavailable." },
      chargeable_weight_kg: { type: "number", description: "Higher of actual_weight_kg and volumetric_weight_kg. This is the shipping weight to bill." },
      uk: routeSchema("GBP"),
      usa: routeSchema("USD"),
      uae: routeSchema("AED"),
      notes: { type: "string" }
    },
    required: ["name", "brand", "model", "actual_weight_kg", "dimensions_cm", "volumetric_weight_kg", "chargeable_weight_kg", "uk", "usa", "uae", "notes"]
  };

  const prompt = `You are a product research assistant for On Trend, a Tanzania-based global shopping service.\n\nProduct URL pasted by the client:\n${url}\n\nUse live web search. Your first job is product identity, not pricing. Open/search the pasted URL and identify the exact product title, brand, model, SKU/ASIN/item code, colour, size, storage, pack size, and variant.\n\nProduct matching rules:\n- Do NOT quote a generic similar product when a model/variant can be identified.\n- Prefer exact matches by brand + model/SKU/ASIN + variant.\n- If an exact product is unavailable in a market, use null for that market rather than substituting a visibly different product.\n- If the same exact product is unavailable but a very close official variant exists, only use it with confidence "low" or "medium" and explain briefly in notes.\n- Prefer Amazon UK for UK, Amazon US for USA, and Noon UAE for UAE. If unavailable, use another reputable retailer in that market.\n\nWeight rules:\n- Find or estimate actual packed shipping weight in kg.\n- Find or estimate packed dimensions in cm: length, width, height. Use retail package dimensions, not only item dimensions, when possible.\n- Calculate volumetric_weight_kg = length * width * height / 5000.\n- Calculate chargeable_weight_kg = max(actual_weight_kg, volumetric_weight_kg).\n- If dimensions are unavailable, estimate package dimensions from the product category and be conservative, especially for bulky/light items like bags, shoes, hats, toys, bedding, small appliances, lamps, and boxes.\n\nReturn only the structured JSON. Do not include internal rates, markup, fees, or breakdowns. Do not quote restricted items such as weapons, alcohol, drugs, adult items, gambling products, or unsafe products.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 42000);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
        input: prompt,
        text: {
          format: {
            type: "json_schema",
            name: "on_trend_quote_lookup_v2",
            strict: true,
            schema
          }
        }
      })
    });

    clearTimeout(timeout);
    const data = await response.json();

    if (!response.ok) {
      const message = data?.error?.message || "OpenAI request failed.";
      return json(response.status >= 500 ? 502 : 400, { error: message });
    }

    const outputText = getOutputText(data).trim();
    if (!outputText) return json(502, { error: "No quote data was returned. Please try another product link." });

    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch (_) {
      return json(502, { error: "The quote response could not be read. Please try again." });
    }

    const result = sanitizeQuote(parsed, url);
    const hasAnyPrice = [result.uk.price, result.usa.price, result.uae.price].some(Boolean);
    if (!hasAnyPrice) {
      return json(404, { error: "We could not find current prices for this exact product. Please send the link on WhatsApp for a manual quote." });
    }

    memoryCache.set(url, { createdAt: Date.now(), data: result });
    return json(200, result);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      return json(504, { error: "The quote lookup took too long. Please try again or send the link on WhatsApp." });
    }
    return json(500, { error: "Something went wrong while creating the quote. Please try again." });
  }
};
