# Automatic X bookmarks: browser-session beta

No X developer account, OAuth client ID, paid API credits, or client secret is
required. This connector reads your own rendered bookmarks page using your
existing signed-in Chrome session. It does not extract cookies, replay private
API requests, post, like, or change bookmarks on X.

## Enable

1. Run `npm run build` and reload the extension from `dist` at `chrome://extensions`.
2. Open OpenMemory → Settings → Integrations → X bookmarks.
3. Choose **Connect X**. An X bookmarks tab opens in the foreground.
4. Sign in to X if needed. If login redirected away from bookmarks, choose
   **Reconnect** in OpenMemory after signing in.
5. Keep the tab open during the initial scan. Imported batches appear in the
   extension's X count and are keyword-searchable with Source → X bookmarks.

Every 15 minutes while Chrome runs, the extension opens its own inactive X
bookmarks tab, verifies the signed-in handle, reads posts as it scrolls, and
closes that tab after the scan completes. It only scrolls its managed scan tab.
The initial foreground tab stays open so you can inspect it.
On X's newer History page, the reader selects the Bookmarks tab and reads only
its named timeline. It does not import the other History timelines. Video poster
images can be indexed as thumbnails; this does not analyze full video content.

## Controls and limits

- **Sync X** starts or restarts the reader immediately from saved progress; only one managed scan runs at a time.
- **Pause** invalidates the active reader and stops scheduled scans. **Resume**
  schedules another scan. The compact card shows only Sync X and Pause/Resume.
- Changing the signed-in X handle pauses syncing before accepting that account's
  data. Switch back, or disconnect before connecting a different account.
- Each batch is saved immediately and deduplicated by post ID. The reader saves
  its document, scroll position and last visible post. A scan chunk runs for at
  most 10 minutes, then continues automatically after 30 seconds in the same tab.
  Pausing or closing that tab retains the last post as a replay anchor; a reopened
  page scrolls through saved posts until it reaches that anchor. This uses the
  rendered page rather than a private API cursor. Replaying a large library can
  take time if its tab was closed or reloaded.
- A scan finishes when the rendered page stops advancing.
  "Last checked" is not a guarantee that every bookmark was imported. Lazy loading,
  collapsed text, deleted posts, account restrictions and page changes can limit it.
- Imported posts remain saved when unbookmarked or missing from a later scan.
  This beta does not mirror deletions or bookmark folders.
- Chrome must be running with an authenticated X session. The extension cannot
  bypass login challenges or operate while the browser is closed.

## Data and platform rules

Post text, links, author handles and image URLs stay in extension IndexedDB.
Images load from X's media hosts when displayed. Cloud sync is off until you
explicitly enable it in the X settings. The current web app is a shared beta with
no sign-in: cloud-synced X posts can be visible to visitors. Do not enable it for
private posts until account-isolated sign-in is implemented.

## Cloud sync and automatic embeddings

1. Configure Supabase in extension settings. The extension and backend must use
   the same Supabase project.
2. Apply `supabase/migrations/20261031115247_add_x_bookmarks.sql`. It adds a separate
   X table and search function with RLS enabled and service-role-only access.
3. Only for a deliberately shared beta, apply `supabase/x_shared_beta_access.sql`
   to allow the configured extension client key to upload. Do not apply this
   optional access file for a private multi-user release.
4. Deploy the updated backend and web app. Configure the backend's `SUPABASE_URL`
   and Supabase key. It prefers `SUPABASE_SERVICE_ROLE_KEY`, with the existing
   `SUPABASE_ANON_KEY` supported for the explicitly shared beta. Never put the
   service-role key in the extension.
5. Enable **Sync to shared web app (public)** in the X
   settings. Existing local X posts are backfilled automatically. Upload failures
   remain pending and retry every minute while Chrome runs and X sync is enabled.
6. X appears as a source in web-app search, collections and the canvas. The canvas
   loads X only when its tab is selected.

The backend automatically processes missing text vectors every minute. X and
Pinterest text inference share one queue. Database NULL vectors are durable work:
backend restarts and interrupted imports do not discard pending indexing.
Updating post text invalidates only the text vector; changing the media URL
invalidates only the image vector. Unchanged upserts preserve both.

Image vectors are processed automatically by the existing separate image worker:
run `npm run embeddings:images` on the machine hosting that worker, without a
Pinterest board URL filter. It now polls for both Pinterest and X images. Keep
it running for automatic image indexing. Free Render runs only the text model;
the image model is not loaded there. Missing or failed images remain NULL for
retry, and no placeholder vectors are generated.

Pause stops future X uploads and scans. Disconnect removes local X posts and stops
future cloud sync, but does not delete already uploaded posts from Supabase.

X explicitly prohibits non-API website automation and warns that it may result in
account suspension. This is a browser-based experimental connector, not an
approved X integration. See [X automation rules](https://help.x.com/en/rules-and-policies/x-automation).

## Verification

`npm run test:x` checks extraction from representative DOM fixtures, session and
tab validation, deduplication, timed continuation, closed-tab replay, account changes, pause,
disconnect, local search and settings controls. `npm run build` creates the loadable
extension. Live behavior must still be checked in your signed-in browser; fixtures
cannot guarantee compatibility with the current X page.

`python scripts/image-hosts.test.py` verifies that the image downloader accepts
Pinterest and X media hosts and rejects other hosts, without loading a model.
