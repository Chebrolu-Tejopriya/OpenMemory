#!/usr/bin/env python3
"""
Persistent FastEmbed HTTP Server

Loads the embedding model ONCE at startup and serves requests via HTTP.
Eliminates per-request model loading that caused memory spikes.

Endpoints:
  POST /embed/query  { "text": "..." }  → { "embedding": [...] }
  POST /embed/text   { "text": "..." }  → { "embedding": [...] }
  GET  /health                          → { "status": "ok" }
"""

import os
import sys
import json
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import gc
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse
from embed import download_image

# Model loaded once at startup
_text_model = None
_image_model = None
_model_lock = threading.RLock()

CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")
PORT = int(os.environ.get("EMBED_SERVER_PORT", "3002"))


def load_model():
    global _text_model, _image_model
    with _model_lock:
        if _text_model is None:
            _image_model = None
            gc.collect()
            print("[EmbedServer] Loading FastEmbed model...", flush=True)
            from fastembed import TextEmbedding
            _text_model = TextEmbedding(
                model_name="BAAI/bge-small-en-v1.5",
                cache_dir=CACHE_DIR
            )
            print("[EmbedServer] Model loaded and ready.", flush=True)
    return _text_model


def embed_images(urls):
    global _text_model, _image_model
    paths = []
    try:
        def download(url):
            parsed = urlparse(url)
            if parsed.scheme != 'https' or not (parsed.hostname or '').endswith('.pinimg.com'):
                return None
            path = download_image(url)
            if not path and '/originals/' in url:
                path = download_image(url.replace('/originals/', '/236x/'))
            return path
        with ThreadPoolExecutor(max_workers=4) as pool:
            paths = list(pool.map(download, urls))
        results = [None] * len(urls)
        valid = [(i, path) for i, path in enumerate(paths) if path]
        if valid:
            with _model_lock:
                if _image_model is None:
                    _text_model = None
                    gc.collect()
                    from fastembed import ImageEmbedding
                    _image_model = ImageEmbedding(model_name='Qdrant/clip-ViT-B-32-vision', cache_dir=CACHE_DIR)
                for (index, _), embedding in zip(valid, _image_model.embed([path for _, path in valid], batch_size=4)):
                    results[index] = embedding.tolist()
        return results
    finally:
        for path in paths:
            if path and os.path.isfile(path):
                os.unlink(path)


class EmbedHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress default HTTP logs

    def send_json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"status": "ok", "model": "BAAI/bge-small-en-v1.5"})
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        try:
            body = self.read_body()
            if self.path == '/embed/texts':
                texts = body.get('texts')
                if not isinstance(texts, list) or not 0 < len(texts) <= 30 or not all(isinstance(text, str) for text in texts):
                    self.send_json(400, {'error': 'Provide between 1 and 30 texts'})
                    return
                with _model_lock:
                    embeddings = [embedding.tolist() for embedding in load_model().embed(texts)]
                self.send_json(200, {'embeddings': embeddings, 'dimension': 384})
                return
            if self.path == '/embed/images':
                urls = body.get('urls')
                if not isinstance(urls, list) or not 0 < len(urls) <= 4 or not all(isinstance(url, str) for url in urls):
                    self.send_json(400, {'error': 'Provide between 1 and 4 image URLs'})
                    return
                self.send_json(200, {'embeddings': embed_images(urls), 'dimension': 512})
                return
            text = body.get("text", "")

            if not text:
                self.send_json(400, {"error": "text is required"})
                return

            with _model_lock:
                model = load_model()
                if self.path == "/embed/query":
                    embeddings = list(model.query_embed(text))
                elif self.path == "/embed/text":
                    embeddings = list(model.embed([text]))
                else:
                    self.send_json(404, {"error": "Not found"})
                    return

            embedding = embeddings[0].tolist()
            self.send_json(200, {"embedding": embedding, "dimension": len(embedding)})

        except Exception as e:
            print(f"[EmbedServer] Error: {e}", flush=True)
            self.send_json(500, {"error": str(e)})


if __name__ == "__main__":
    # Pre-load model at startup
    load_model()

    server = ThreadingHTTPServer(("127.0.0.1", PORT), EmbedHandler)
    print(f"[EmbedServer] Listening on port {PORT}", flush=True)
    server.serve_forever()
