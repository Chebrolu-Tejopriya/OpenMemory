-- Run against the configured project with Supabase CLI db query --file.
-- All synthetic data is rolled back. Never touches Chrome or Pinterest rows.
begin;
do $$
declare
  test_post text := (extract(epoch from clock_timestamp()) * 1000000)::bigint::text;
  row_id uuid;
  matches integer;
  text_vector vector(384) := array_fill(0.1::real, array[384])::vector;
  image_vector vector(512) := array_fill(0.1::real, array[512])::vector;
begin
  insert into public.x_bookmarks(account_username,post_id,url,title,description,author,image_url)
  values ('codex_test',test_post,'https://x.com/i/status/' || test_post,'codexverificationtoken','Components and design systems','@designer','https://pbs.twimg.com/media/test-a.jpg') returning id into row_id;
  update public.x_bookmarks set embedding=text_vector,image_embedding=image_vector where id=row_id;
  update public.x_bookmarks set title=title,description=description,image_url=image_url where id=row_id;
  if exists(select 1 from public.x_bookmarks where id=row_id and (embedding is null or image_embedding is null)) then raise exception 'Unchanged upsert erased vectors'; end if;
  select count(*) into matches from public.search_x_bookmarks('codexverificationtoken',null,100) s where s.url='https://x.com/i/status/' || test_post;
  if matches <> 1 then raise exception 'X text search failed'; end if;
  update public.x_bookmarks set description='Changed content' where id=row_id;
  if not exists(select 1 from public.x_bookmarks where id=row_id and embedding is null and image_embedding is not null) then raise exception 'Text update invalidation failed'; end if;
  update public.x_bookmarks set embedding=text_vector where id=row_id;
  update public.x_bookmarks set image_url='https://pbs.twimg.com/media/test-b.jpg' where id=row_id;
  if not exists(select 1 from public.x_bookmarks where id=row_id and embedding is not null and image_embedding is null) then raise exception 'Image update invalidation failed'; end if;
end; $$;
rollback;
select relrowsecurity as x_rls_enabled, has_table_privilege('anon','public.x_bookmarks','SELECT') as anonymous_read_enabled
from pg_class where oid='public.x_bookmarks'::regclass;
