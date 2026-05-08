exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let url;
  try {
    const body = JSON.parse(event.body);
    url = body.url;
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  if (!url) {
    return { statusCode: 400, body: JSON.stringify({ error: "No URL provided" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "API key not configured" }) };
  }

  const prompt = `You are a product research assistant for On Trend, a Tanzania-based shopping service.

Given this product URL: ${url}

1. Identify the product name (max 60 chars)
2. Find the price on the linked page
3. Search for the SAME product on the other two markets (Amazon UK in GBP, Amazon US in USD, Noon or Amazon UAE in AED)
4. Estimate the shipping weight in kg based on product type and specs

Respond ONLY with raw JSON, no markdown, no explanation:
{"name":"product name","weight_kg":0.0,"uk":{"price":0.00,"currency":"GBP","store":"Amazon UK"},"usa":{"price":0.00,"currency":"USD","store":"Amazon US"},"uae":{"price":0.00,"currency":"AED","store":"Noon"}}

Use null for price if not found in that market.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 2000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Anthropic API error", details: data })
      };
    }

    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const rawText = textBlocks.map(b => b.text).join("");
    const jsonMatch = rawText.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Could not parse product data", raw: rawText })
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify(parsed)
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
