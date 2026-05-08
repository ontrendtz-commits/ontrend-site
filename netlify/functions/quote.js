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

  const apiKey = process.env.ANTHROPIC_API_KEY;

  const prompt = `You are a product research assistant for On Trend, a Tanzania-based shopping service.

Given this product URL: ${url}

Search for this product and find:
1. Product name (max 60 chars)
2. Price in GBP on Amazon UK
3. Price in USD on Amazon US  
4. Price in AED on Noon UAE
5. Estimated shipping weight in kg

Respond ONLY with raw JSON:
{"name":"product name","weight_kg":0.5,"uk":{"price":0.00,"currency":"GBP","store":"Amazon UK"},"usa":{"price":0.00,"currency":"USD","store":"Amazon US"},"uae":{"price":0.00,"currency":"AED","store":"Noon"}}

Use null for price if not found.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Anthropic error: " + JSON.stringify(data) })
      };
    }

    const rawText = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const jsonMatch = rawText.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Parse error", raw: rawText })
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: jsonMatch[0]
    };

  } catch (err) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message })
    };
  }
};
