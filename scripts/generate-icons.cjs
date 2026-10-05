const fs = require('fs');
const path = require('path');

// Copy committed logo icons so every extension build preserves the branding.
const sourcePath = path.join(__dirname, '..', 'src', 'extension', 'icons');
const distPath = path.join(__dirname, '..', 'dist');
fs.mkdirSync(distPath, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const filename = `icon${size}.png`;
  fs.copyFileSync(path.join(sourcePath, filename), path.join(distPath, filename));
  console.log(`Copied ${filename}`);
}
