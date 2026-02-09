/**
 * OpenMemory - Pinterest Integration
 * Cookie-based login detection and scraping logic
 */

import { db, PinterestPin } from './db';

// ============== INTERFACES ==============
export interface PinterestLoginStatus {
  loggedIn: boolean;
  username?: string;
}

export interface ScrapedBoard {
  name: string;
  url: string;
}

export interface ScrapedPin {
  pinId: string;
  title: string;
  imageUrl: string;
  pinUrl: string;
  description?: string;
}

// Pinterest domains to check
const PINTEREST_DOMAINS = [
  'https://www.pinterest.com',
  'https://in.pinterest.com',
  'https://pinterest.com',
  'https://br.pinterest.com',
  'https://de.pinterest.com',
  'https://fr.pinterest.com'
];

// ============== LOGIN DETECTION ==============
export async function checkPinterestLogin(): Promise<PinterestLoginStatus> {
  try {
    console.log('[Pinterest] Checking login status...');

    // Check for Pinterest session cookie across different domains
    for (const domain of PINTEREST_DOMAINS) {
      const sessionCookie = await chrome.cookies.get({
        url: domain,
        name: '_pinterest_sess'
      });

      if (sessionCookie) {
        console.log('[Pinterest] Session cookie found for:', domain);
        return { loggedIn: true };
      }

      const authCookie = await chrome.cookies.get({
        url: domain,
        name: '_auth'
      });

      if (authCookie) {
        console.log('[Pinterest] Auth cookie found for:', domain);
        return { loggedIn: true };
      }
    }

    console.log('[Pinterest] No cookies found');
    return { loggedIn: false };
  } catch (error) {
    console.error('[Pinterest] Login check error:', error);
    return { loggedIn: false };
  }
}

// ============== INJECTED SCRAPING FUNCTIONS ==============
// These functions are serialized and injected into Pinterest pages

export interface ScrapeBoardsResult {
  boards: ScrapedBoard[];
  debug: {
    url: string;
    username: string;
    totalLinks: number;
    userLinks: string[];
    bodyLength: number;
    foundInJson: boolean;
    jsonBoards: string[];
  };
}

export function scrapePinterestBoards(): ScrapeBoardsResult {
  const boards: ScrapedBoard[] = [];
  const pathname = window.location.pathname;
  const username = pathname.split('/')[1]; // Get username from URL
  const baseUrl = window.location.origin;

  let foundInJson = false;
  const jsonBoards: string[] = [];

  // Method 1: Try to find board data in script tags (Pinterest embeds JSON data)
  const scripts = document.querySelectorAll('script');
  scripts.forEach(script => {
    const content = script.textContent || '';
    // Look for board URLs in JSON data
    const boardMatches = content.matchAll(/"\/([^"]+)\/([a-zA-Z0-9\-_]+)\/"/g);
    for (const match of boardMatches) {
      const [, user, boardSlug] = match;
      if (user.toLowerCase() === username?.toLowerCase()) {
        const skipSlugs = ['_saved', '_created', '_pins', 'pin', 'settings', 'following', 'followers'];
        if (!skipSlugs.includes(boardSlug.toLowerCase()) && /^[a-zA-Z0-9\-_]+$/.test(boardSlug)) {
          const url = `${baseUrl}/${user}/${boardSlug}/`;
          if (!boards.some(b => b.url === url)) {
            foundInJson = true;
            jsonBoards.push(boardSlug);
            boards.push({ name: boardSlug.replace(/-/g, ' '), url });
          }
        }
      }
    }
  });

  // Method 2: Look for elements with data attributes or aria-labels containing board info
  if (boards.length === 0) {
    document.querySelectorAll('[data-test-id*="board"], [data-test-id*="Board"], [role="listitem"]').forEach(el => {
      const link = el.querySelector('a') as HTMLAnchorElement;
      const href = link?.href || el.getAttribute('data-href') || '';
      const boardMatch = href.match(/pinterest\.com\/([^\/]+)\/([^\/]+)\/?$/);
      if (boardMatch) {
        const [, linkUser, boardSlug] = boardMatch;
        if (linkUser.toLowerCase() === username?.toLowerCase()) {
          const name = el.textContent?.trim().split('\n')[0] || boardSlug.replace(/-/g, ' ');
          if (!boards.some(b => b.url === href)) {
            boards.push({ name: name.substring(0, 50), url: href });
          }
        }
      }
    });
  }

  // Method 3: Look for any element with href attribute (not just <a> tags)
  if (boards.length === 0) {
    document.querySelectorAll('[href*="pinterest.com"]').forEach(el => {
      const href = el.getAttribute('href') || '';
      const fullUrl = href.startsWith('/') ? baseUrl + href : href;
      const boardMatch = fullUrl.match(/pinterest\.com\/([^\/]+)\/([^\/]+)\/?$/);
      if (boardMatch) {
        const [, linkUser, boardSlug] = boardMatch;
        const skipSlugs = ['_saved', '_created', '_pins', 'pin', 'settings', 'following', 'followers', 'ideas', 'search'];
        if (linkUser.toLowerCase() === username?.toLowerCase() && !skipSlugs.includes(boardSlug.toLowerCase())) {
          const name = boardSlug.replace(/-/g, ' ');
          if (!boards.some(b => b.url === fullUrl)) {
            boards.push({ name: name.substring(0, 50), url: fullUrl });
          }
        }
      }
    });
  }

  // Method 4: Parse the HTML for board patterns
  if (boards.length === 0) {
    const html = document.body.innerHTML;
    const boardPattern = new RegExp(`/${username}/([a-zA-Z0-9\\-_]+)/`, 'gi');
    const matches = html.matchAll(boardPattern);
    for (const match of matches) {
      const boardSlug = match[1];
      const skipSlugs = ['_saved', '_created', '_pins', 'pin', 'settings', 'following', 'followers', 'ideas'];
      if (!skipSlugs.includes(boardSlug.toLowerCase())) {
        const url = `${baseUrl}/${username}/${boardSlug}/`;
        if (!boards.some(b => b.url === url)) {
          boards.push({ name: boardSlug.replace(/-/g, ' '), url });
        }
      }
    }
  }

  // Collect debug info
  const allLinks = document.querySelectorAll('a');
  const userLinks: string[] = [];
  allLinks.forEach(link => {
    const href = (link as HTMLAnchorElement).href;
    if (href && href.toLowerCase().includes(username?.toLowerCase() || '') && !href.includes('#')) {
      userLinks.push(href);
    }
  });

  return {
    boards,
    debug: {
      url: window.location.href,
      username: username || '',
      totalLinks: allLinks.length,
      userLinks: userLinks.slice(0, 20),
      bodyLength: document.body.innerHTML.length,
      foundInJson,
      jsonBoards: jsonBoards.slice(0, 10)
    }
  };
}

export function scrapeBoardPins(): ScrapedPin[] {
  const pins: ScrapedPin[] = [];

  console.log('[Pinterest Scraper] Looking for pins on:', window.location.href);
  console.log('[Pinterest Scraper] Page title:', document.title);
  console.log('[Pinterest Scraper] Body length:', document.body.innerHTML.length);

  // Find all pin links on the page
  const pinLinks = document.querySelectorAll('a[href*="/pin/"]');
  console.log('[Pinterest Scraper] Found', pinLinks.length, 'pin links');

  // Also try finding images directly
  const allImages = document.querySelectorAll('img[src*="pinimg.com"]');
  console.log('[Pinterest Scraper] Found', allImages.length, 'Pinterest images');

  pinLinks.forEach(link => {
    const pinUrl = (link as HTMLAnchorElement).href;
    const pinIdMatch = pinUrl.match(/\/pin\/(\d+)/);
    const pinId = pinIdMatch?.[1] || '';

    if (!pinId || pins.some(p => p.pinId === pinId)) return;

    // Find image in or near this link
    let img = link.querySelector('img') as HTMLImageElement;
    if (!img) {
      const parent = link.closest('div');
      img = parent?.querySelector('img') as HTMLImageElement;
    }

    const imageUrl = img?.src || img?.dataset?.src || '';

    pins.push({
      pinId,
      title: img?.alt || '',
      imageUrl,
      pinUrl,
      description: ''
    });
  });

  // If no pins found via links, try to extract from images
  if (pins.length === 0 && allImages.length > 0) {
    console.log('[Pinterest Scraper] Trying to extract pins from images...');
    allImages.forEach((img, index) => {
      const imgEl = img as HTMLImageElement;
      const src = imgEl.src || '';
      // Try to find a nearby pin link
      const container = imgEl.closest('div[data-test-id]') || imgEl.closest('div');
      const pinLink = container?.querySelector('a[href*="/pin/"]') as HTMLAnchorElement;

      if (pinLink) {
        const pinIdMatch = pinLink.href.match(/\/pin\/(\d+)/);
        const pinId = pinIdMatch?.[1] || `img_${index}`;

        if (!pins.some(p => p.pinId === pinId)) {
          pins.push({
            pinId,
            title: imgEl.alt || '',
            imageUrl: src,
            pinUrl: pinLink.href,
            description: ''
          });
        }
      }
    });
  }

  console.log('[Pinterest Scraper] Total pins found:', pins.length);
  if (pins.length > 0) {
    console.log('[Pinterest Scraper] First pin:', pins[0]);
  }

  return pins.slice(0, 50);
}

// Function to scroll and wait for content to load
export function scrollToLoadContent(): Promise<void> {
  return new Promise((resolve) => {
    let scrollCount = 0;
    const maxScrolls = 8;

    const scrollInterval = setInterval(() => {
      window.scrollBy(0, window.innerHeight * 0.8);
      scrollCount++;
      console.log('[Pinterest Scraper] Scroll', scrollCount, 'of', maxScrolls);

      if (scrollCount >= maxScrolls) {
        clearInterval(scrollInterval);
        window.scrollTo(0, 0);
        setTimeout(resolve, 2000);
      }
    }, 800);
  });
}

// ============== PIN PROCESSING ==============
export async function processPin(
  pin: ScrapedPin,
  boardName: string,
  boardUrl: string
): Promise<void> {
  // Check if pin already exists
  const existing = await db.pins.where('pinId').equals(pin.pinId).first();
  if (existing) {
    return;
  }

  // Store in database (skip image conversion for now - use original URL)
  const pinData: PinterestPin = {
    pinId: pin.pinId,
    boardName,
    boardUrl,
    title: pin.title,
    description: pin.description,
    pinUrl: pin.pinUrl,
    originalImageUrl: pin.imageUrl,
    // imageBlob: undefined - skip for now, use originalImageUrl directly
    syncedAt: Date.now()
  };

  await db.pins.add(pinData);
}

// ============== IMAGE CONVERSION ==============
let offscreenDocumentCreated = false;

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenDocumentCreated) return;

  try {
    // Check if offscreen document already exists
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
    });

    if (existingContexts.length > 0) {
      offscreenDocumentCreated = true;
      return;
    }

    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS' as chrome.offscreen.Reason],
      justification: 'Convert Pinterest images to WebP format for storage'
    });

    offscreenDocumentCreated = true;
  } catch (error) {
    console.warn('[Pinterest] Failed to create offscreen document:', error);
  }
}

async function convertImageToWebP(imageUrl: string): Promise<Blob | undefined> {
  await ensureOffscreenDocument();

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CONVERT_IMAGE_TO_WEBP',
      imageUrl
    });

    if (response && response.blob) {
      // Convert array buffer back to blob
      return new Blob([response.blob], { type: 'image/webp' });
    }
  } catch (error) {
    console.warn('[Pinterest] Image conversion failed:', error);
  }

  return undefined;
}

// ============== INTEGRATION MANAGEMENT ==============
export async function initializePinterestIntegration(): Promise<void> {
  const existing = await db.integrations.where('name').equals('pinterest').first();

  if (!existing) {
    await db.integrations.add({
      name: 'pinterest',
      connected: false,
      syncStatus: 'idle'
    });
  }
}

export async function updatePinterestIntegration(updates: Partial<{
  username: string;
  connected: boolean;
  lastSyncAt: number;
  syncStatus: 'idle' | 'syncing' | 'error';
  syncProgress: number;
  totalPins: number;
}>): Promise<void> {
  await db.integrations.where('name').equals('pinterest').modify(updates);
}

export async function getPinterestIntegration() {
  return db.integrations.where('name').equals('pinterest').first();
}
