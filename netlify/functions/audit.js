import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Normalize URL
function normalizeUrl(url) {
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

// Fetch website
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

// Extract structured content from HTML
function extractStructuredContent(html) {
  if (!html) return { metaTitle: '', metaDescription: '', h1: '', subheadline: '', text: '' };

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaTitle = titleMatch ? titleMatch[1].trim() : '';

  const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
  const metaDescription = metaDescMatch ? metaDescMatch[1].trim() : '';

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let h1 = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').trim() : '';

  const h2Match = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  let subheadline = h2Match ? h2Match[1].replace(/<[^>]+>/g, '').trim() : '';

  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().substring(0, 1500);

  return { metaTitle, metaDescription, h1: h1.substring(0, 200), subheadline: subheadline.substring(0, 300), text };
}

// Extract messaging
async function extractMessaging(companyName, content) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `You're a senior brand strategist. Extract ${companyName}'s messaging essence.

H1: "${content.h1}"
SUBHEADLINE: "${content.subheadline}"
CONTENT: ${content.text}

Return JSON:
{
  "positioning": "<10 words max: what they do + for whom>",
  "voiceAdjectives": ["<adjective>", "<adjective>", "<adjective>"],
  "voiceSummary": "<one short sentence capturing their tone>"
}

Return ONLY JSON.`
    }]
  });

  for (const block of response.content) {
    if (block.type === 'text') {
      const jsonMatch = block.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    }
  }
  return null;
}

// First impressions
async function analyzeFirstImpressions(companyName, metaTitle, metaDescription, h1) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 250,
    messages: [{
      role: 'user',
      content: `You're a potential customer researching ${companyName}. Based on their search result and headline, what's your first impression?

Title: "${metaTitle}"
Description: "${metaDescription}"
H1: "${h1}"

Return JSON:
{
  "firstImpression": "<2-3 sentences: what would a customer think?>",
  "clarity": "<one sentence: is it clear what they do?>",
  "appeal": "<one sentence: would a customer want to learn more?>"
}

Return ONLY JSON.`
    }]
  });

  for (const block of response.content) {
    if (block.type === 'text') {
      const jsonMatch = block.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    }
  }
  return null;
}

// Generate takeaways
async function generateTakeaways(companyName, companyData, competitorData, comparison) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `You're a senior brand strategist giving actionable advice to ${companyName}.

YOUR BRAND: Positioning: ${companyData.positioning}, Voice: ${companyData.voiceAdjectives?.join(', ')}
COMPETITORS: ${competitorData.map(c => `${c.name}: ${c.positioning}`).join(', ')}
SCORE: ${comparison.score}/100
OVERLAPS: ${comparison.overlaps?.map(o => o.pattern).join(', ') || 'None'}

Return JSON:
{
  "keep": ["<what's working>"],
  "fix": ["<what's holding them back>"],
  "explore": ["<white space to claim>"],
  "watch": ["<threats to monitor>"]
}

Return ONLY JSON.`
    }]
  });

  for (const block of response.content) {
    if (block.type === 'text') {
      const jsonMatch = block.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    }
  }
  return null;
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { companyUrl, companyName, competitors } = JSON.parse(event.body);

    if (!companyUrl || !companyName || !competitors?.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    // Fetch websites
    const companyHtml = await fetchWebsite(companyUrl);
    const companyStructured = extractStructuredContent(companyHtml);

    const competitorData = await Promise.all(
      competitors.map(async (comp) => ({
        name: comp.name,
        url: comp.url,
        structured: extractStructuredContent(await fetchWebsite(comp.url))
      }))
    );

    // Analyze company
    const companyMessaging = await extractMessaging(companyName, companyStructured);
    await new Promise(r => setTimeout(r, 500));
    const companyFirstImpressions = await analyzeFirstImpressions(
      companyName, companyStructured.metaTitle, companyStructured.metaDescription, companyStructured.h1
    );

    // Analyze competitors
    const competitorResults = [];
    for (const comp of competitorData) {
      await new Promise(r => setTimeout(r, 500));
      const messaging = await extractMessaging(comp.name, comp.structured);
      await new Promise(r => setTimeout(r, 500));
      const firstImpressions = await analyzeFirstImpressions(
        comp.name, comp.structured.metaTitle, comp.structured.metaDescription, comp.structured.h1
      );
      competitorResults.push({
        name: comp.name,
        url: comp.url,
        scraped: { h1: comp.structured.h1, subheadline: comp.structured.subheadline },
        inferred: messaging || {},
        firstImpressions: firstImpressions || {}
      });
    }

    // Compare brands
    await new Promise(r => setTimeout(r, 500));
    const formatVoice = (inf) => inf?.voiceAdjectives?.join(', ') || 'unknown';
    const brandSummaries = [
      `${companyName}: "${companyMessaging?.positioning}" | Voice: ${formatVoice(companyMessaging)}`,
      ...competitorResults.map(c => `${c.name}: "${c.inferred.positioning}" | Voice: ${formatVoice(c.inferred)}`)
    ].join('\n');

    const comparisonResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You're a senior brand strategist. Compare these brands:

${brandSummaries}

Return JSON:
{
  "score": <0-100: how differentiated is ${companyName}?>,
  "overlaps": [{"category": "<positioning/voice>", "pattern": "<what's similar>", "who": ["<brand>", "<brand>"]}],
  "standouts": ["<what makes ${companyName} different>"],
  "verdict": "<one punchy sentence>"
}

Return ONLY JSON.`
      }]
    });

    let comparison = null;
    for (const block of comparisonResponse.content) {
      if (block.type === 'text') {
        const jsonMatch = block.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) comparison = JSON.parse(jsonMatch[0]);
      }
    }

    // Generate takeaways
    await new Promise(r => setTimeout(r, 500));
    const takeaways = await generateTakeaways(
      companyName,
      { ...companyMessaging, ...companyFirstImpressions },
      competitorResults.map(c => ({ name: c.name, ...c.inferred })),
      comparison || {}
    );

    // Build chart
    const formatVoiceFull = (inf) => {
      const adjs = inf?.voiceAdjectives?.join(', ') || '';
      const summary = inf?.voiceSummary || '';
      return adjs ? `${adjs}${summary ? ' — ' + summary : ''}` : summary || '—';
    };

    const chartData = {
      columns: ['Category', companyName, ...competitorResults.map(c => c.name)],
      rows: [
        { category: 'Positioning', values: [companyMessaging?.positioning || '—', ...competitorResults.map(c => c.inferred.positioning || '—')] },
        { category: 'Voice', values: [formatVoiceFull(companyMessaging), ...competitorResults.map(c => formatVoiceFull(c.inferred))] }
      ]
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        score: comparison?.score || 50,
        verdict: comparison?.verdict || '',
        overlaps: comparison?.overlaps || [],
        standouts: comparison?.standouts || [],
        takeaways: takeaways || {},
        chart: chartData,
        firstImpressions: {
          [companyName]: { ...companyFirstImpressions, metaTitle: companyStructured.metaTitle, metaDescription: companyStructured.metaDescription },
          ...Object.fromEntries(competitorResults.map(c => [c.name, { ...c.firstImpressions, metaTitle: c.scraped.metaTitle, metaDescription: c.scraped.metaDescription }]))
        }
      })
    };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
