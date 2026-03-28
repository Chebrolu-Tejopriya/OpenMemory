# Supabase Setup for Real-time Bookmark Sync

This guide explains how to set up Supabase for real-time bookmark synchronization.

## Prerequisites

1. Create a Supabase account at https://supabase.com
2. Create a new project
3. Have your OpenAI API key ready for embedding generation

## Step 1: Run Database Migration

1. Go to your Supabase project dashboard
2. Navigate to **SQL Editor**
3. Copy and paste the contents of `migrations/001_create_bookmarks.sql`
4. Click **Run** to execute the migration

This creates:
- `bookmarks` table with URL as unique key
- pgvector extension for similarity search
- `search_bookmarks` function for semantic search
- Necessary indexes for performance

## Step 2: Deploy Edge Function

### Option A: Using Supabase CLI

```bash
# Install Supabase CLI if not already installed
npm install -g supabase

# Login to Supabase
supabase login

# Link to your project
supabase link --project-ref YOUR_PROJECT_REF

# Set OpenAI API key as secret
supabase secrets set OPENAI_API_KEY=your_openai_api_key

# Deploy the edge function
supabase functions deploy generate-embedding
```

### Option B: Manual Deployment via Dashboard

1. Go to **Edge Functions** in your Supabase dashboard
2. Click **Create a new function**
3. Name it `generate-embedding`
4. Copy the contents of `functions/generate-embedding/index.ts`
5. Add environment variable: `OPENAI_API_KEY`

## Step 3: Configure the Extension

In your extension's side panel or options page, configure Supabase:

1. Get your **Supabase URL** from Project Settings > API
2. Get your **anon/public key** from Project Settings > API
3. Configure via the extension:

```javascript
// Send message to background script
chrome.runtime.sendMessage({
  type: 'CONFIGURE_SUPABASE',
  url: 'https://your-project.supabase.co',
  anonKey: 'your-anon-key'
});
```

## Step 4: Initial Sync

To sync all existing bookmarks to Supabase:

```javascript
chrome.runtime.sendMessage({ type: 'SYNC_ALL_TO_SUPABASE' });
```

After this, all bookmark changes (create, update, delete) will sync in real-time.

## How It Works

### Event Listeners

The extension listens to these Chrome bookmark events:

| Event | Action | Embedding |
|-------|--------|-----------|
| `onCreated` | UPSERT to Supabase | Generate new |
| `onRemoved` | DELETE from Supabase | N/A |
| `onChanged` | UPDATE title | Regenerate if title changed |
| `onMoved` | UPDATE folder | No regeneration |

### Duplicate Prevention

- URL is the unique key (UPSERT operation)
- Existing bookmarks are updated, not duplicated
- Only incremental changes are sent, not full dataset

### Embedding Optimization

- Embeddings only generated for:
  - New bookmarks
  - Bookmarks with title changes
- Folder-only changes don't regenerate embeddings
- Uses OpenAI `text-embedding-3-small` (1536 dimensions)

## API Reference

### Messages to Background Script

```typescript
// Configure Supabase
{ type: 'CONFIGURE_SUPABASE', url: string, anonKey: string }

// Check if configured
{ type: 'CHECK_SUPABASE_CONFIG' } // Returns { configured: boolean }

// Get sync status
{ type: 'GET_SUPABASE_SYNC_STATUS' } // Returns SyncStatus

// Full sync
{ type: 'SYNC_ALL_TO_SUPABASE' } // Returns { success, failed }

// Sync single bookmark
{ type: 'SYNC_BOOKMARK_TO_SUPABASE', url, title, folder }

// Delete from Supabase
{ type: 'DELETE_BOOKMARK_FROM_SUPABASE', url?, chromeId? }
```

## Troubleshooting

### "Supabase not configured"
Run `CONFIGURE_SUPABASE` message with your credentials.

### "Embedding generation failed"
- Check if `OPENAI_API_KEY` is set in Edge Function secrets
- Verify the Edge Function is deployed and running

### Bookmarks not syncing
- Check the browser console for errors
- Verify Supabase credentials are correct
- Ensure the `bookmarks` table exists

## Cost Estimation

- **Supabase**: Free tier includes 500MB database, 50K Edge Function invocations
- **OpenAI Embeddings**: ~$0.02 per 1M tokens (~0.0001 per bookmark)

For 1000 bookmarks: ~$0.10 one-time for embeddings
