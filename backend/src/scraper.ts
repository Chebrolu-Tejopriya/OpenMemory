import * as cheerio from 'cheerio';

/**
 * Metadata extracted from a webpage for rich embeddings.
 */
export interface PageMetadata {
  domain: string;
  pageTitle: string | null;
  metaDescription: string | null;
  metaKeywords: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogSiteName: string | null;
  h1: string[];
  h2: string[];
}

/**
 * Extracts metadata from a webpage for embedding enrichment.
 */
export async function scrapePageMetadata(url: string): Promise<PageMetadata | null> {
  try {
    const domain = new URL(url).hostname.replace('www.', '');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return { domain, pageTitle: null, metaDescription: null, metaKeywords: null, ogTitle: null, ogDescription: null, ogSiteName: null, h1: [], h2: [] };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract metadata
    const pageTitle = $('title').first().text().trim() || null;
    const metaDescription = $('meta[name="description"]').attr('content')?.trim() || null;
    const metaKeywords = $('meta[name="keywords"]').attr('content')?.trim() || null;

    // Open Graph tags
    const ogTitle = $('meta[property="og:title"]').attr('content')?.trim() || null;
    const ogDescription = $('meta[property="og:description"]').attr('content')?.trim() || null;
    const ogSiteName = $('meta[property="og:site_name"]').attr('content')?.trim() || null;

    // Headers (limit to first few for relevance)
    const h1: string[] = [];
    $('h1').slice(0, 3).each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length < 200) h1.push(text);
    });

    const h2: string[] = [];
    $('h2').slice(0, 5).each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length < 200) h2.push(text);
    });

    return {
      domain,
      pageTitle,
      metaDescription,
      metaKeywords,
      ogTitle,
      ogDescription,
      ogSiteName,
      h1,
      h2,
    };
  } catch (err) {
    // Return minimal metadata on error
    try {
      const domain = new URL(url).hostname.replace('www.', '');
      return { domain, pageTitle: null, metaDescription: null, metaKeywords: null, ogTitle: null, ogDescription: null, ogSiteName: null, h1: [], h2: [] };
    } catch {
      return null;
    }
  }
}

/**
 * Builds rich embedding text from all available metadata.
 */
export function buildEmbeddingText(item: {
  title: string;
  folder: string | null;
  source: string;
  metadata?: PageMetadata | null;
}): string {
  const parts: string[] = [];

  // Primary: Title (most important)
  parts.push(item.title);

  // Folder path provides category context
  if (item.folder) {
    parts.push(`Category: ${item.folder.replace(/\//g, ' > ')}`);
  }

  // Add scraped metadata if available
  if (item.metadata) {
    const m = item.metadata;

    // Domain/site name
    if (m.ogSiteName) {
      parts.push(`Site: ${m.ogSiteName}`);
    } else if (m.domain) {
      parts.push(`Site: ${m.domain}`);
    }

    // Meta description (rich SEO content)
    if (m.metaDescription) {
      parts.push(m.metaDescription);
    }

    // OG description (often more detailed)
    if (m.ogDescription && m.ogDescription !== m.metaDescription) {
      parts.push(m.ogDescription);
    }

    // Keywords
    if (m.metaKeywords) {
      parts.push(`Keywords: ${m.metaKeywords}`);
    }

    // Headers provide topic structure
    if (m.h1.length > 0) {
      parts.push(`Headings: ${m.h1.join(', ')}`);
    }
    if (m.h2.length > 0) {
      parts.push(m.h2.join(', '));
    }
  }

  // Source at the end
  parts.push(`Source: ${item.source}`);

  return parts.join('. ');
}
