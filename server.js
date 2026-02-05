// Backend API for Competitive Brand Audit
// This uses Claude to analyze websites and find competitors

import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Serve static files (the HTML frontend)
app.use(express.static(__dirname));
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.use(cors());
app.use(express.json());

// Helper function to normalize URL
function normalizeUrl(url) {
  url = url.trim();
  // Add https:// if no protocol
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

// Take screenshot of website above the fold
async function takeScreenshot(url) {
  url = normalizeUrl(url);
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    // Wait a bit for any animations/lazy loading
    await new Promise(r => setTimeout(r, 1000));
    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 80 });
    await browser.close();
    return screenshot;
  } catch (error) {
    console.error(`Error screenshotting ${url}:`, error.message);
    if (browser) await browser.close();
    return null;
  }
}

// Take screenshot of Google search results
async function takeGoogleScreenshot(searchQuery) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await new Promise(r => setTimeout(r, 500));
    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 80 });
    await browser.close();
    return screenshot;
  } catch (error) {
    console.error(`Error screenshotting Google for ${searchQuery}:`, error.message);
    if (browser) await browser.close();
    return null;
  }
}

// Helper function to fetch website content
async function fetchWebsite(url) {
  url = normalizeUrl(url);
  try {
    const response = await fetch(url);
    const html = await response.text();
    return html;
  } catch (error) {
    // If failed, try with www. prefix
    if (!url.includes('://www.')) {
      const wwwUrl = url.replace('://', '://www.');
      try {
        const response = await fetch(wwwUrl);
        const html = await response.text();
        return html;
      } catch (e) {
        console.error(`Error fetching ${url}:`, error);
        return null;
      }
    }
    console.error(`Error fetching ${url}:`, error);
    return null;
  }
}

// Helper function to extract structured content from HTML
function extractStructuredContent(html) {
  // Extract meta title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaTitle = titleMatch ? titleMatch[1].trim() : '';

  // Extract meta description
  const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
  const metaDescription = metaDescMatch ? metaDescMatch[1].trim() : '';

  // Extract H1
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let h1 = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').trim() : '';

  // Extract first H2 or large text after H1 as subheadline
  const h2Match = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  let subheadline = h2Match ? h2Match[1].replace(/<[^>]+>/g, '').trim() : '';

  // If no H2, try to find a p tag near the top
  if (!subheadline) {
    const pMatch = html.match(/<p[^>]*class="[^"]*(?:hero|subtitle|lead|intro)[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    subheadline = pMatch ? pMatch[1].replace(/<[^>]+>/g, '').trim() : '';
  }

  // Extract colors from inline styles and CSS
  const colorMatches = html.match(/(?:color|background|background-color)\s*:\s*(#[0-9a-fA-F]{3,6}|rgb\([^)]+\)|[a-z]+)/gi) || [];
  const colors = [...new Set(colorMatches.map(c => c.split(':')[1]?.trim()).filter(Boolean))].slice(0, 5);

  // Extract font families
  const fontMatches = html.match(/font-family\s*:\s*['"]?([^'";,]+)/gi) || [];
  const fonts = [...new Set(fontMatches.map(f => f.split(':')[1]?.trim().replace(/['"]/g, '')).filter(Boolean))].slice(0, 3);

  // Also check for Google Fonts links
  const googleFontMatch = html.match(/fonts\.googleapis\.com\/css[^"']+family=([^"'&]+)/i);
  if (googleFontMatch) {
    const googleFonts = decodeURIComponent(googleFontMatch[1]).split('|').map(f => f.split(':')[0]);
    fonts.push(...googleFonts);
  }

  // Get clean text for context (remove scripts/styles first)
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  text = text.replace(/\s+/g, ' ').trim().substring(0, 1500);

  return {
    metaTitle: metaTitle.substring(0, 200),
    metaDescription: metaDescription.substring(0, 300),
    h1: h1.substring(0, 200),
    subheadline: subheadline.substring(0, 300),
    colors: colors.join(', ') || 'Could not detect',
    fonts: [...new Set(fonts)].slice(0, 3).join(', ') || 'Could not detect',
    text
  };
}

// Extract messaging from text content
async function extractMessaging(companyName, structuredContent) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `You're a senior brand strategist. Extract ${companyName}'s messaging essence.

H1: "${structuredContent.h1}"
SUBHEADLINE: "${structuredContent.subheadline}"

CONTENT:
${structuredContent.text}

Return JSON:
{
  "positioning": "<10 words max: what they do + for whom>",
  "voiceAdjectives": ["<adjective>", "<adjective>", "<adjective>"],
  "voiceSummary": "<one short sentence capturing their tone>"
}

Be sharp and brief.
Return ONLY JSON.`
    }]
  });

  for (const block of response.content) {
    if (block.type === 'text') {
      try {
        const jsonMatch = block.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.error('Error parsing messaging:', e);
      }
    }
  }
  return null;
}

// Generate first impressions analysis
async function analyzeFirstImpressions(companyName, metaTitle, metaDescription, websiteScreenshot, googleScreenshot) {
  const content = [
    {
      type: 'text',
      text: `You're a potential customer researching ${companyName}. Based on their Google search result and website homepage, what's your first impression?

GOOGLE SEARCH RESULT:
- Title: "${metaTitle}"
- Description: "${metaDescription}"

Look at the Google search screenshot and website screenshot below.`
    }
  ];

  if (googleScreenshot) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: googleScreenshot }
    });
  }

  if (websiteScreenshot) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: websiteScreenshot }
    });
  }

  content.push({
    type: 'text',
    text: `Return JSON:
{
  "firstImpression": "<2-3 sentences: what would a customer think when they first encounter this brand?>",
  "clarity": "<one sentence: is it immediately clear what they do?>",
  "appeal": "<one sentence: would a customer want to learn more?>"
}

IMPORTANT: If you see a CAPTCHA, bot protection, or Cloudflare challenge screen in the screenshot, IGNORE IT. That's just from automated scraping - real visitors don't see it. Base your analysis on the meta title/description and assume the website loads normally for humans.

Be honest and specific. Write like a real customer, not a marketer.
Return ONLY JSON.`
  });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{ role: 'user', content }]
  });

  for (const block of response.content) {
    if (block.type === 'text') {
      try {
        const jsonMatch = block.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.error('Error parsing first impressions:', e);
      }
    }
  }
  return null;
}

// Generate "What This Means For You" takeaways
async function generateTakeaways(companyName, companyData, competitorData, comparison) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `You're a senior brand strategist giving actionable advice to ${companyName} based on their competitive audit.

YOUR BRAND:
- Positioning: ${companyData.positioning}
- Voice: ${companyData.voiceAdjectives?.join(', ')}
- Visual: ${companyData.colors}, ${companyData.typography}, ${companyData.visualStyle}
- First Impression: ${companyData.firstImpression}

COMPETITORS:
${competitorData.map(c => `- ${c.name}: ${c.positioning} | Voice: ${c.voiceAdjectives?.join(', ')} | Visual: ${c.visualStyle}`).join('\n')}

AUDIT FINDINGS:
- Score: ${comparison.score}/100
- Overlaps: ${comparison.overlaps?.map(o => o.pattern).join(', ') || 'None'}
- Standouts: ${comparison.standouts?.join(', ') || 'None'}

Return JSON with actionable takeaways for ${companyName}:
{
  "keep": ["<what's working, don't change it>", "<another if relevant>"],
  "fix": ["<what's holding them back, be specific>", "<another if relevant>"],
  "explore": ["<white space competitors aren't claiming>", "<another if relevant>"],
  "watch": ["<threats or risks to be aware of>"]
}

Be direct and specific. No fluff. Each bullet should be actionable.
Return ONLY JSON.`
    }]
  });

  for (const block of response.content) {
    if (block.type === 'text') {
      try {
        const jsonMatch = block.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.error('Error parsing takeaways:', e);
      }
    }
  }
  return null;
}

// Extract visual identity from screenshot
async function extractVisuals(companyName, screenshotBase64) {
  if (!screenshotBase64) {
    return { colors: 'Could not capture', typography: 'Could not capture', visualStyle: 'Could not capture' };
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 250,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: screenshotBase64
          }
        },
        {
          type: 'text',
          text: `You're a brand designer. Look at this screenshot of ${companyName}'s website and describe their visual identity.

Return JSON:
{
  "colors": "<list the 2-4 main brand colors you see, e.g. 'navy blue, white, coral accent'>",
  "typography": "<describe the typography: e.g. 'bold geometric sans-serif', 'elegant serif', 'clean grotesque'>",
  "visualStyle": "<brief description of imagery/art direction: e.g. 'lifestyle photography, warm tones', 'abstract illustrations', 'type-focused, minimal'>"
}

IMPORTANT: If you see a CAPTCHA, bot protection, or Cloudflare challenge screen, return "Could not capture" for all fields - that's just from automated scraping, not the real site.

Be specific about what you actually see. Keep each field under 10 words.
Return ONLY JSON.`
        }
      ]
    }]
  });

  for (const block of response.content) {
    if (block.type === 'text') {
      try {
        const jsonMatch = block.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.error('Error parsing visuals:', e);
      }
    }
  }
  return { colors: 'Unknown', typography: 'Unknown', visualStyle: 'Unknown' };
}

// Suggest competitors endpoint
app.post('/api/suggest-competitors', async (req, res) => {
  try {
    const { companyUrl, companyName } = req.body;

    if (!companyUrl || !companyName) {
      return res.status(400).json({ error: 'Missing company URL or name' });
    }

    console.log('Finding competitors for:', companyName);

    // Fetch the company website to understand what they do
    const html = await fetchWebsite(companyUrl);
    const structured = extractStructuredContent(html || '');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Based on this company's website, suggest 3 direct competitors.

COMPANY: ${companyName}
H1: "${structured.h1}"
CONTENT: ${structured.text.substring(0, 800)}

Return JSON with 3 real competitors (not made up):
{
  "competitors": [
    {"name": "<competitor name>", "url": "<their domain, e.g. competitor.com>", "reason": "<why they compete, 5 words max>"},
    {"name": "<competitor name>", "url": "<their domain>", "reason": "<why>"},
    {"name": "<competitor name>", "url": "<their domain>", "reason": "<why>"}
  ]
}

Only suggest real companies that actually exist and compete in the same space.
Return ONLY JSON.`
      }]
    });

    for (const block of response.content) {
      if (block.type === 'text') {
        try {
          const jsonMatch = block.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            console.log('Suggested competitors:', data.competitors);
            return res.json(data);
          }
        } catch (e) {
          console.error('Error parsing competitors:', e);
        }
      }
    }

    res.json({ competitors: [] });
  } catch (error) {
    console.error('Error suggesting competitors:', error);
    res.status(500).json({ error: error.message });
  }
});

// Main audit endpoint
app.post('/api/audit', async (req, res) => {
  try {
    const { companyUrl, companyName, competitors } = req.body;

    if (!companyUrl || !companyName || !competitors || competitors.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log('Starting audit for:', companyName);
    console.log('Competitors:', competitors);

    // Step 1: Fetch content and take screenshots in parallel
    console.log('Fetching websites and taking screenshots...');

    const [companyHtml, companyScreenshot, companyGoogleScreenshot, ...competitorFetches] = await Promise.all([
      fetchWebsite(companyUrl),
      takeScreenshot(companyUrl),
      takeGoogleScreenshot(companyName),
      ...competitors.map(async (comp) => ({
        name: comp.name,
        url: comp.url,
        html: await fetchWebsite(comp.url),
        screenshot: await takeScreenshot(comp.url),
        googleScreenshot: await takeGoogleScreenshot(comp.name)
      }))
    ]);

    const companyStructured = extractStructuredContent(companyHtml || '');
    const competitorData = competitorFetches.map(comp => ({
      ...comp,
      structured: extractStructuredContent(comp.html || '')
    }));

    // Step 2: Extract messaging and visuals (sequentially to avoid rate limits)
    console.log('Analyzing', companyName, 'messaging...');
    const companyMessaging = await extractMessaging(companyName, companyStructured);

    console.log('Analyzing', companyName, 'visuals...');
    await new Promise(resolve => setTimeout(resolve, 500));
    const companyVisuals = await extractVisuals(companyName, companyScreenshot);

    console.log('Analyzing', companyName, 'first impressions...');
    await new Promise(resolve => setTimeout(resolve, 500));
    const companyFirstImpressions = await analyzeFirstImpressions(
      companyName,
      companyStructured.metaTitle,
      companyStructured.metaDescription,
      companyScreenshot,
      companyGoogleScreenshot
    );

    const companyInferred = { ...companyMessaging, ...companyVisuals };

    if (!companyMessaging) {
      return res.status(500).json({ error: 'Could not analyze your website' });
    }

    const competitorResults = [];
    for (const comp of competitorData) {
      console.log('Analyzing', comp.name, '...');
      await new Promise(resolve => setTimeout(resolve, 500));
      const messaging = await extractMessaging(comp.name, comp.structured);
      await new Promise(resolve => setTimeout(resolve, 500));
      const visuals = await extractVisuals(comp.name, comp.screenshot);
      await new Promise(resolve => setTimeout(resolve, 500));
      const firstImpressions = await analyzeFirstImpressions(
        comp.name,
        comp.structured.metaTitle,
        comp.structured.metaDescription,
        comp.screenshot,
        comp.googleScreenshot
      );
      competitorResults.push({
        name: comp.name,
        url: comp.url,
        scraped: {
          h1: comp.structured.h1,
          subheadline: comp.structured.subheadline,
          metaTitle: comp.structured.metaTitle,
          metaDescription: comp.structured.metaDescription
        },
        inferred: { ...(messaging || {}), ...(visuals || {}) },
        firstImpressions: firstImpressions || {},
        googleScreenshot: comp.googleScreenshot
      });
    }

    // Step 3: Compare all brands
    console.log('Comparing brands...');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Build comparison data for Claude
    const formatVoiceForComparison = (inf) => inf?.voiceAdjectives?.join(', ') || 'unknown';

    const allBrands = [
      { name: companyName, positioning: companyInferred.positioning, voice: formatVoiceForComparison(companyInferred), visual: companyInferred.visualStyle },
      ...competitorResults.map(c => ({ name: c.name, positioning: c.inferred.positioning, voice: formatVoiceForComparison(c.inferred), visual: c.inferred.visualStyle }))
    ];

    const brandSummaries = allBrands.map(b =>
      `${b.name}: "${b.positioning}" | Voice: ${b.voice} | Visual: ${b.visual}`
    ).join('\n');

    const analysisResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You're a senior brand strategist giving a client a quick category overview.

BRANDS IN THIS SPACE:
${brandSummaries}

Return JSON:
{
  "score": <0-100: how differentiated is ${companyName}? 50 = average, 80+ = truly distinct>,
  "overlaps": [
    {
      "category": "<'positioning' or 'voice' or 'visual'>",
      "pattern": "<the generic pattern you see, 5-10 words>",
      "who": ["<brand>", "<brand>"]
    }
  ],
  "standouts": ["<one thing that makes ${companyName} different, if anything>"],
  "verdict": "<one punchy sentence: the honest truth about ${companyName}'s differentiation>"
}

Be direct. Skip the fluff. What would you actually tell a client?
Return ONLY JSON.`
      }]
    });

    let comparison = null;
    for (const block of analysisResponse.content) {
      if (block.type === 'text') {
        try {
          const jsonMatch = block.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            comparison = JSON.parse(jsonMatch[0]);
          }
        } catch (e) {
          console.error('Error parsing comparison:', e);
        }
      }
    }

    if (!comparison) {
      return res.status(500).json({ error: 'Could not compare brands' });
    }

    // Format voice & tone as "adjective, adjective, adjective — summary"
    const formatVoice = (inferred) => {
      if (!inferred) return '—';
      const adjs = inferred.voiceAdjectives?.join(', ') || '';
      const summary = inferred.voiceSummary || '';
      return adjs ? `${adjs}${summary ? ' — ' + summary : ''}` : summary || '—';
    };

    // Build the chart data (simplified: just positioning, voice, visual)
    const chartData = {
      columns: ['Category', companyName, ...competitorResults.map(c => c.name)],
      rows: [
        {
          category: 'Positioning',
          values: [companyInferred.positioning, ...competitorResults.map(c => c.inferred.positioning)]
        },
        {
          category: 'Voice',
          values: [formatVoice(companyInferred), ...competitorResults.map(c => formatVoice(c.inferred))]
        },
        {
          category: 'Visual Style',
          values: [
            `${companyInferred.colors || ''} · ${companyInferred.typography || ''} · ${companyInferred.visualStyle || ''}`.replace(/^ · | · $/g, ''),
            ...competitorResults.map(c => `${c.inferred.colors || ''} · ${c.inferred.typography || ''} · ${c.inferred.visualStyle || ''}`.replace(/^ · | · $/g, ''))
          ]
        }
      ]
    };

    // Generate takeaways for the user's brand
    console.log('Generating takeaways...');
    await new Promise(resolve => setTimeout(resolve, 500));
    const takeaways = await generateTakeaways(
      companyName,
      { ...companyInferred, ...companyFirstImpressions },
      competitorResults.map(c => ({ name: c.name, ...c.inferred })),
      comparison
    );

    console.log('Analysis complete');
    res.json({
      score: comparison.score,
      verdict: comparison.verdict,
      overlaps: comparison.overlaps,
      standouts: comparison.standouts,
      takeaways: takeaways || {},
      chart: chartData,
      screenshots: {
        [companyName]: { url: normalizeUrl(companyUrl), image: companyScreenshot },
        ...Object.fromEntries(competitorResults.map((c, i) => [c.name, { url: normalizeUrl(competitors[i].url), image: competitorData[i].screenshot }]))
      },
      googleScreenshots: {
        [companyName]: companyGoogleScreenshot,
        ...Object.fromEntries(competitorResults.map(c => [c.name, c.googleScreenshot]))
      },
      firstImpressions: {
        [companyName]: {
          ...companyFirstImpressions,
          metaTitle: companyStructured.metaTitle,
          metaDescription: companyStructured.metaDescription
        },
        ...Object.fromEntries(competitorResults.map(c => [c.name, {
          ...c.firstImpressions,
          metaTitle: c.scraped.metaTitle,
          metaDescription: c.scraped.metaDescription
        }]))
      }
    });

  } catch (error) {
    console.error('Error in audit endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Brand audit API running on port ${PORT}`);
});
