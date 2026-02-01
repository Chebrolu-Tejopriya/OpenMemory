/**
 * Exports all bookmarks with embeddings to a JSON file for the Chrome extension.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllItems, getAllFolders } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('Exporting bookmarks for Chrome extension...');

  const items = getAllItems();
  const folders = getAllFolders();

  console.log(`Found ${items.length} bookmarks`);

  // Prepare export data
  const exportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    folders,
    items: items.map(item => ({
      id: item.id,
      source: item.source,
      title: item.title,
      url: item.url,
      folder: item.folder,
      intent: item.intent,
      metadata: item.metadata,
      embedding: item.embedding,
      created_at: item.created_at,
    })),
  };

  // Write to extension dist folder
  const distPath = path.join(__dirname, '..', '..', 'dist');
  if (!fs.existsSync(distPath)) {
    fs.mkdirSync(distPath, { recursive: true });
  }

  const outputPath = path.join(distPath, 'data.json');
  fs.writeFileSync(outputPath, JSON.stringify(exportData));

  console.log(`Exported to: ${outputPath}`);
  console.log(`File size: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
