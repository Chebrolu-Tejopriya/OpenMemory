"""
Generate embeddings for Pinterest pins using local FastEmbed
Uses the same BAAI/bge-small-en-v1.5 model (384 dimensions)
"""

import os
import json
from dotenv import load_dotenv
from supabase import create_client, Client
from fastembed import TextEmbedding

# Load environment variables
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("Error: Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env file")
    exit(1)

# Initialize Supabase client
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Initialize FastEmbed model (same as used for bookmarks)
print("Loading FastEmbed model (BAAI/bge-small-en-v1.5)...")
model = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
print("Model loaded!")

def get_pins_without_embeddings():
    """Fetch Pinterest pins that don't have embeddings yet"""
    response = supabase.table("pinterest_pins") \
        .select("id, pin_id, title, description, board_name") \
        .is_("embedding", "null") \
        .execute()
    return response.data

def generate_text_for_embedding(pin):
    """Generate the text to embed for a pin"""
    parts = []
    if pin.get("title"):
        parts.append(pin["title"])
    if pin.get("description"):
        parts.append(pin["description"])
    if pin.get("board_name"):
        parts.append(pin["board_name"])
    return " ".join(parts).strip() or "Pinterest Pin"

def update_pin_embedding(pin_id, embedding):
    """Update a pin's embedding in Supabase"""
    response = supabase.table("pinterest_pins") \
        .update({"embedding": embedding}) \
        .eq("id", pin_id) \
        .execute()
    return response

def main():
    # Get pins without embeddings
    print("Fetching Pinterest pins without embeddings...")
    pins = get_pins_without_embeddings()

    if not pins:
        print("All Pinterest pins already have embeddings!")
        return

    print(f"Found {len(pins)} pins without embeddings")

    # Generate text for each pin
    texts = [generate_text_for_embedding(pin) for pin in pins]

    # Generate embeddings in batches
    batch_size = 32
    total_success = 0
    total_failed = 0

    for i in range(0, len(pins), batch_size):
        batch_pins = pins[i:i+batch_size]
        batch_texts = texts[i:i+batch_size]

        print(f"Processing batch {i//batch_size + 1}/{(len(pins)-1)//batch_size + 1} ({len(batch_pins)} pins)...")

        # Generate embeddings for the batch
        embeddings = list(model.embed(batch_texts))

        # Update each pin with its embedding
        for pin, embedding in zip(batch_pins, embeddings):
            try:
                embedding_list = embedding.tolist()
                update_pin_embedding(pin["id"], embedding_list)
                total_success += 1
            except Exception as e:
                print(f"  Error updating pin {pin['pin_id']}: {e}")
                total_failed += 1

        print(f"  Batch complete: {total_success} success, {total_failed} failed")

    print(f"\n✅ Done! {total_success} embeddings generated, {total_failed} failed")

if __name__ == "__main__":
    main()
