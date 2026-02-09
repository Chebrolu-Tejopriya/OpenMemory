/**
 * OpenMemory - Offscreen Document
 * Handles image conversion to WebP using OffscreenCanvas
 */

// Handle image conversion requests from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CONVERT_IMAGE_TO_WEBP') {
    convertToWebP(message.imageUrl)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Offscreen] Conversion error:', error);
        sendResponse({ error: error.message });
      });
    return true; // Async response
  }
});

async function convertToWebP(imageUrl: string): Promise<{ blob?: ArrayBuffer; error?: string }> {
  try {
    // Fetch the image
    const response = await fetch(imageUrl, {
      mode: 'cors',
      credentials: 'omit'
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const originalBlob = await response.blob();

    // Create image bitmap
    const bitmap = await createImageBitmap(originalBlob);

    // Calculate dimensions (max 800px width to save space)
    const maxWidth = 800;
    let width = bitmap.width;
    let height = bitmap.height;

    if (width > maxWidth) {
      height = Math.round((height * maxWidth) / width);
      width = maxWidth;
    }

    // Create offscreen canvas and draw
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    ctx.drawImage(bitmap, 0, 0, width, height);

    // Convert to WebP blob
    const webpBlob = await canvas.convertToBlob({
      type: 'image/webp',
      quality: 0.8
    });

    // Convert blob to array buffer for message passing
    const arrayBuffer = await webpBlob.arrayBuffer();

    return { blob: arrayBuffer };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { error: message };
  }
}
