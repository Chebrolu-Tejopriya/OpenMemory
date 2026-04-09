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
from http.server import HTTPServer, BaseHTTPRequestHandler

# Model loaded once at startup
_text_model = None
_model_lock = threading.Lock()

CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")
PORT = int(os.environ.get("EMBED_SERVER_PORT", "3002"))


def load_model():
    global _text_model
    with _model_lock:
        if _text_model is None:
            print("[EmbedServer] Loading FastEmbed model...", flush=True)
            from fastembed import TextEmbedding
            _text_model = TextEmbedding(
                model_name="BAAI/bge-small-en-v1.5",
                cache_dir=CACHE_DIR
            )
            print("[EmbedServer] Model loaded and ready.", flush=True)
    return _text_model


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
            text = body.get("text", "")

            if not text:
                self.send_json(400, {"error": "text is required"})
                return

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

    server = HTTPServer(("127.0.0.1", PORT), EmbedHandler)
    print(f"[EmbedServer] Listening on port {PORT}", flush=True)
    server.serve_forever()
