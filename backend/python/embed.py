#!/usr/bin/env python3
"""
FastEmbed Embedding Service

Provides text and image embeddings using Qdrant's FastEmbed library.

Text Model: BAAI/bge-small-en-v1.5 (384 dimensions)
Image Model: Qdrant/clip-ViT-B-32-vision (512 dimensions)

Usage:
  python embed.py text "your text here"
  python embed.py image "https://example.com/image.jpg"
  python embed.py image "/path/to/local/image.jpg"
  python embed.py batch-text '["text1", "text2"]'
  python embed.py batch-image '["url1", "url2"]'
"""

import sys
import json
import os
from typing import List, Optional
import tempfile
import requests

# Lazy loading of models to avoid startup overhead
_text_model = None
_image_model = None

# Cache directory for models
CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")


def get_text_model():
    """Initialize text embedding model (BGE-small-en-v1.5, 384 dim)"""
    global _text_model
    if _text_model is None:
        from fastembed import TextEmbedding
        _text_model = TextEmbedding(
            model_name="BAAI/bge-small-en-v1.5",
            cache_dir=CACHE_DIR
        )
    return _text_model


def get_image_model():
    """Initialize image embedding model (CLIP ViT-B/32, 512 dim)"""
    global _image_model
    if _image_model is None:
        from fastembed import ImageEmbedding
        _image_model = ImageEmbedding(
            model_name="Qdrant/clip-ViT-B-32-vision",
            cache_dir=CACHE_DIR
        )
    return _image_model


def embed_text(text: str) -> List[float]:
    """Generate text embedding using BGE-small model"""
    model = get_text_model()
    embeddings = list(model.embed([text]))
    return embeddings[0].tolist()


def embed_texts(texts: List[str]) -> List[List[float]]:
    """Generate batch text embeddings"""
    model = get_text_model()
    embeddings = list(model.embed(texts))
    return [emb.tolist() for emb in embeddings]


def embed_query(query: str) -> List[float]:
    """Generate query embedding (optimized for search)"""
    model = get_text_model()
    embeddings = list(model.query_embed(query))
    return embeddings[0].tolist()


def download_image(url: str) -> Optional[str]:
    """Download image from URL to temp file"""
    try:
        response = requests.get(url, timeout=10, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
        response.raise_for_status()

        # Determine file extension from content type
        content_type = response.headers.get('content-type', 'image/jpeg')
        ext = '.jpg'
        if 'png' in content_type:
            ext = '.png'
        elif 'webp' in content_type:
            ext = '.webp'
        elif 'gif' in content_type:
            ext = '.gif'

        # Save to temp file
        fd, path = tempfile.mkstemp(suffix=ext)
        with os.fdopen(fd, 'wb') as f:
            f.write(response.content)
        return path
    except requests.exceptions.Timeout:
        print(f"Timeout downloading image", file=sys.stderr)
        return None
    except requests.exceptions.HTTPError as e:
        print(f"HTTP error {e.response.status_code}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"Failed to download: {type(e).__name__}", file=sys.stderr)
        return None


def embed_image(image_path_or_url: str) -> Optional[List[float]]:
    """Generate image embedding using CLIP model"""
    temp_file = None
    try:
        # Check if it's a URL
        if image_path_or_url.startswith(('http://', 'https://')):
            temp_file = download_image(image_path_or_url)
            if temp_file is None:
                return None
            image_path = temp_file
        else:
            image_path = image_path_or_url

        # Check file exists
        if not os.path.exists(image_path):
            print(f"Image file not found: {image_path}", file=sys.stderr)
            return None

        model = get_image_model()
        embeddings = list(model.embed([image_path]))
        return embeddings[0].tolist()
    except Exception as e:
        print(f"Failed to embed image: {e}", file=sys.stderr)
        return None
    finally:
        # Clean up temp file
        if temp_file and os.path.exists(temp_file):
            os.unlink(temp_file)


def embed_images(image_paths_or_urls: List[str]) -> List[Optional[List[float]]]:
    """Generate batch image embeddings with parallel downloads"""
    import concurrent.futures

    # Download images in parallel
    temp_files = []
    local_paths = []

    def download_single(url: str) -> Optional[str]:
        if url.startswith(('http://', 'https://')):
            return download_image(url)
        return url if os.path.exists(url) else None

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        temp_files = list(executor.map(download_single, image_paths_or_urls))

    # Filter successful downloads
    valid_indices = []
    valid_paths = []
    for i, path in enumerate(temp_files):
        if path:
            valid_indices.append(i)
            valid_paths.append(path)

    # Batch embed all valid images at once
    results: List[Optional[List[float]]] = [None] * len(image_paths_or_urls)

    if valid_paths:
        try:
            model = get_image_model()
            embeddings = list(model.embed(valid_paths))
            for idx, emb in zip(valid_indices, embeddings):
                results[idx] = emb.tolist()
        except Exception as e:
            print(f"Batch embedding failed: {e}", file=sys.stderr)

    # Clean up temp files
    for path in temp_files:
        if path and path.startswith(tempfile.gettempdir()) and os.path.exists(path):
            try:
                os.unlink(path)
            except:
                pass

    return results


def main():
    if len(sys.argv) < 3:
        print(json.dumps({
            "error": "Usage: embed.py <command> <input>",
            "commands": ["text", "image", "query", "batch-text", "batch-image"]
        }))
        sys.exit(1)

    command = sys.argv[1]
    input_data = sys.argv[2]

    try:
        if command == "text":
            embedding = embed_text(input_data)
            print(json.dumps({"embedding": embedding, "dimension": len(embedding)}))

        elif command == "query":
            embedding = embed_query(input_data)
            print(json.dumps({"embedding": embedding, "dimension": len(embedding)}))

        elif command == "image":
            embedding = embed_image(input_data)
            if embedding:
                print(json.dumps({"embedding": embedding, "dimension": len(embedding)}))
            else:
                print(json.dumps({"embedding": None, "error": "Failed to embed image"}))

        elif command == "batch-text":
            texts = json.loads(input_data)
            embeddings = embed_texts(texts)
            print(json.dumps({"embeddings": embeddings, "count": len(embeddings)}))

        elif command == "batch-image":
            urls = json.loads(input_data)
            embeddings = embed_images(urls)
            print(json.dumps({"embeddings": embeddings, "count": len(embeddings)}))

        else:
            print(json.dumps({"error": f"Unknown command: {command}"}))
            sys.exit(1)

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
