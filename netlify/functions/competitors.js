import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

function normalizeUrl(url) {
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

async function fetchWebsite(url) {
  url = normalizeUrl(url);
  try {
    const response = await fetch(url);
    return await response.text();
  } catch (error) {
    try {
      const wwwUrl = url.replace('://', '://www.');
      const response = await fetch(wwwUrl);
      return await response.text();
    } catch (e) {
      return null;
    }
  }
}

function extractStructuredContent(html) {
  if (!html) return { h1: '', text: '' };

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let h1 = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').trim() : '';

  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/\s+/g, ' ').trim().substring(0, 800);

  return { h1, text };
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { companyUrl, companyName } = JSON.parse(event.body);

    if (!companyUrl || !companyName) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing company URL or name' }) };
    }

    const html = await fetchWebsite(companyUrl);
    const structured = extractStructuredContent(html);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Based on this company's website, suggest 3 direct competitors.

COMPANY: ${companyName}
H1: "${structured.h1}"
CONTENT: ${structured.text}

Return JSON with 3 real competitors:
{
  "competitors": [
    {"name": "<competitor name>", "url": "<their domain>", "reason": "<why they compete, 5 words max>"}
  ]
}

Only suggest real companies. Return ONLY JSON.`
      }]
    });

    for (const block of response.content) {
      if (block.type === 'text') {
        const jsonMatch = block.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: jsonMatch[0]
          };
        }
      }
    }

    return { statusCode: 200, body: JSON.stringify({ competitors: [] }) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
