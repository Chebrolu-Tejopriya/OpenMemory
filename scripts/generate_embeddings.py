"""
Local Embedding Generator using FastEmbed
Generates embeddings for all bookmarks and uploads to Supabase
"""

import os
import sys
from typing import List
import requests
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_ANON_KEY = os.getenv('SUPABASE_ANON_KEY')

if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    print("Error: Please set SUPABASE_URL and SUPABASE_ANON_KEY in .env file")
    print("Example .env file:")
    print("SUPABASE_URL=https://your-project.supabase.co")
    print("SUPABASE_ANON_KEY=your-anon-key")
    sys.exit(1)

# Install fastembed if not present
try:
    from fastembed import TextEmbedding
except ImportError:
    print("Installing fastembed...")
    os.system(f"{sys.executable} -m pip install fastembed")
    from fastembed import TextEmbedding

def get_bookmarks_without_embeddings() -> List[dict]:
    """Fetch all bookmarks that don't have embeddings yet"""
    headers = {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': f'Bearer {SUPABASE_ANON_KEY}'
    }

    response = requests.get(
        f'{SUPABASE_URL}/rest/v1/bookmarks?embedding=is.null&select=id,title,folder,url',
        headers=headers
    )

    if response.status_code != 200:
        print(f"Error fetching bookmarks: {response.status_code} {response.text}")
        return []

    return response.json()

def update_bookmark_embedding(bookmark_id: str, embedding: List[float]) -> bool:
    """Update a bookmark with its embedding"""
    headers = {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': f'Bearer {SUPABASE_ANON_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
    }

    response = requests.patch(
        f'{SUPABASE_URL}/rest/v1/bookmarks?id=eq.{bookmark_id}',
        headers=headers,
        json={'embedding': embedding}
    )

    return response.status_code in [200, 204]

def main():
    print("=" * 60)
    print("FastEmbed Local Embedding Generator")
    print("=" * 60)

    # Fetch bookmarks
    print("\nFetching bookmarks without embeddings...")
    bookmarks = get_bookmarks_without_embeddings()

    if not bookmarks:
        print("No bookmarks need embeddings. All done!")
        return

    print(f"Found {len(bookmarks)} bookmarks to process")

    # Initialize FastEmbed model (384 dimensions, same as all-MiniLM-L6-v2)
    print("\nLoading embedding model (first time may download ~90MB)...")
    model = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
    print("Model loaded!")

    # Process bookmarks in batches
    BATCH_SIZE = 32
    success_count = 0
    fail_count = 0

    print(f"\nGenerating embeddings in batches of {BATCH_SIZE}...")

    for i in range(0, len(bookmarks), BATCH_SIZE):
        batch = bookmarks[i:i + BATCH_SIZE]

        # Prepare texts for embedding
        texts = []
        for b in batch:
            text = f"{b['title']} {b.get('folder') or ''}".strip()
            texts.append(text[:512])  # Truncate to 512 chars

        # Generate embeddings for batch
        embeddings = list(model.embed(texts))

        # Update each bookmark
        for j, bookmark in enumerate(batch):
            embedding = embeddings[j].tolist()

            if update_bookmark_embedding(bookmark['id'], embedding):
                success_count += 1
            else:
                fail_count += 1
                print(f"  Failed: {bookmark['title'][:50]}")

        # Progress
        progress = min(i + BATCH_SIZE, len(bookmarks))
        percent = (progress / len(bookmarks)) * 100
        print(f"Progress: {progress}/{len(bookmarks)} ({percent:.1f}%) - Success: {success_count}, Failed: {fail_count}")

    print("\n" + "=" * 60)
    print(f"COMPLETE!")
    print(f"  Success: {success_count}")
    print(f"  Failed: {fail_count}")
    print("=" * 60)

if __name__ == "__main__":
    main()
