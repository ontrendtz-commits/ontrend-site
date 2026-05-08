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

function sanitizeQuote(raw, url) {
  const route = (entry, currency, store) => ({
    price: typeof entry?.price === "number" && entry.price > 0 ? Number(entry.price.toFixed(2)) : null,
    currency,
    store: entry?.store || store
  });

  return {
    order_ref: raw.order_ref || makeOrderRef(),
    source_url: url,
    name: String(raw.name || "Product quote").slice(0, 80),
    weight_kg: Math.max(0.1, Number(raw.weight_kg || 0.5)),
    uk: route(raw.uk, "GBP", "Amazon UK / UK retailer"),
    usa: route(raw.usa, "USD", "Amazon US / US retailer"),
    uae: route(raw.uae, "AED", "Noon / UAE retailer"),
    notes: raw.notes ? String(raw.notes).slice(0, 180) : "Live web lookup estimate. Final invoice confirmed before order."
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

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "Product name, max 80 characters." },
      weight_kg: { type: "number", description: "Estimated packed shipping weight in kg." },
      uk: {
        type: "object",
        additionalProperties: false,
        properties: {
          price: { type: ["number", "null"], description: "Current UK product price before shipping, in GBP." },
          currency: { type: "string", enum: ["GBP"] },
          store: { type: "string" }
        },
        required: ["price", "currency", "store"]
      },
      usa: {
        type: "object",
        additionalProperties: false,
        properties: {
          price: { type: ["number", "null"], description: "Current US product price before shipping, in USD." },
          currency: { type: "string", enum: ["USD"] },
          store: { type: "string" }
        },
        required: ["price", "currency", "store"]
      },
      uae: {
        type: "object",
        additionalProperties: false,
        properties: {
          price: { type: ["number", "null"], description: "Current UAE product price before shipping, in AED." },
          currency: { type: "string", enum: ["AED"] },
          store: { type: "string" }
        },
        required: ["price", "currency", "store"]
      },
      notes: { type: "string" }
    },
    required: ["name", "weight_kg", "uk", "usa", "uae", "notes"]
  };

  const prompt = `You are a product research assistant for On Trend, a Tanzania-based shopping service.\n\nProduct URL: ${url}\n\nUse live web search. Identify the product, then find the closest available prices for UK, USA, and UAE routes. Prefer Amazon UK for UK, Amazon US for USA, and Noon UAE for UAE; if unavailable, use a reputable retailer in that market. Estimate packed shipping weight from product specs, dimensions, reviews, or similar items.\n\nReturn only the structured JSON. Use null for a route price if you cannot find a reasonable match. Do not include client-facing breakdowns, markup, fees, or internal rates. Do not quote restricted items such as weapons, alcohol, drugs, adult items, gambling products, or unsafe products.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 38000);

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
            name: "on_trend_quote_lookup",
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
      return json(404, { error: "We could not find current prices for this product. Please send the link on WhatsApp for a manual quote." });
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
