-- OPTIONAL: Only for a deliberately shared/public beta, without per-user sign-in.
-- This permits anyone with the project's publishable/anon key to read and write X posts.
-- Do not apply this to a private multi-user product.
grant select, insert, update on public.x_bookmarks to anon;
grant execute on function public.search_x_bookmarks(text, vector, integer) to anon;
create policy x_shared_beta_read on public.x_bookmarks for select to anon using (true);
create policy x_shared_beta_insert on public.x_bookmarks for insert to anon with check (true);
create policy x_shared_beta_update on public.x_bookmarks for update to anon using (true) with check (true);
