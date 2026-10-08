require('esbuild').buildSync({
  entryPoints: ['src/extension/search.ts'],
  bundle: true,
  outfile: 'dist/search.js',
  format: 'iife',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
