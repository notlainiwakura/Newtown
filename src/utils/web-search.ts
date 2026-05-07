/**
 * Shared web search with fallback chain.
 *
 * DuckDuckGo frequently serves a 202 + anomaly.js anti-bot challenge from
 * cloud/datacenter IPs (observed live from the production droplet). The old
 * `web_search` tool in src/agent/tools.ts treated 202 as `response.ok === true`,
 * parsed the challenge page, got zero matches, and silently returned
 * "no results found for \"...\"" — indistinguishable from a real empty search.
 *
 * The research handler in src/web/server.ts already had a three-tier fallback
 * (DDG HTML → DDG Lite → Wikipedia API), and it worked. This module hoists
 * that fallback into one place so every callsite gets the same resilience.
 *
 * Contract: `searchWeb(q)` returns up to 5 hits, empty array if every tier
 * fails. Network errors are swallowed per tier — callers see the result of
 * the cascade, not which specific tier succeeded.
 */

const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export async function searchWeb(query: string): Promise<SearchHit[]> {
  const ddgHtml = await tryDdgHtml(query);
  if (ddgHtml.length > 0) return ddgHtml;

  const ddgLite = await tryDdgLite(query);
  if (ddgLite.length > 0) return ddgLite;

  const wiki = await tryWikipedia(query);
  return wiki;
}

async function tryDdgHtml(query: string): Promise<SearchHit[]> {
  try {
    const resp = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'User-Agent': SEARCH_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `q=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(15000),
    });
    // Note: 202 is the DDG anti-bot challenge. We do not reject it here —
    // the parser returns [] on challenge HTML and we cascade to the next tier.
    if (!resp.ok && resp.status !== 202) return [];
    return parseDdgHtml(await resp.text());
  } catch {
    return [];
  }
}

async function tryDdgLite(query: string): Promise<SearchHit[]> {
  try {
    const resp = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': SEARCH_UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok && resp.status !== 202) return [];
    return parseDdgLite(await resp.text());
  } catch {
    return [];
  }
}

async function tryWikipedia(query: string): Promise<SearchHit[]> {
  try {
    const resp = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5&utf8=1`,
      { headers: { 'User-Agent': SEARCH_UA }, signal: AbortSignal.timeout(10000) },
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      query?: { search?: Array<{ title: string; snippet: string }> };
    };
    const items = data.query?.search ?? [];
    return items.map((item) => {
      const snippet = decodeHtmlEntities(
        item.snippet.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
      );
      const title = decodeHtmlEntities(item.title);
      return {
        title,
        snippet,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      };
    });
  } catch {
    return [];
  }
}

export function parseDdgHtml(html: string): SearchHit[] {
  const results: SearchHit[] = [];
  const blocks = html.split(/class="result\s+results_links/g);
  for (let i = 1; i < blocks.length && results.length < 5; i++) {
    const block = blocks[i] || '';
    const linkMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)</);
    if (!linkMatch) continue;
    const url = linkMatch[1] || '';
    if (!url.startsWith('http')) continue;
    const title = decodeHtmlEntities((linkMatch[2] || '').trim());
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch?.[1]
      ? decodeHtmlEntities(snippetMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      : '';
    results.push({ title, url, snippet });
  }
  return results;
}

export function parseDdgLite(html: string): SearchHit[] {
  const results: SearchHit[] = [];
  const rows = html.split(/<tr>/g);
  for (const row of rows) {
    if (results.length >= 5) break;
    const linkMatch = row.match(/class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;
    const url = (linkMatch[1] || '').trim();
    if (!url.startsWith('http')) continue;
    const title = decodeHtmlEntities((linkMatch[2] || '').replace(/<[^>]+>/g, '').trim());
    const snippetMatch = row.match(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/);
    const snippet = snippetMatch?.[1]
      ? decodeHtmlEntities(snippetMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      : '';
    if (title || snippet) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}
