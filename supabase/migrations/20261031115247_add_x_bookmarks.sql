-- Data stays service-role-only until the optional shared-beta access is enabled.
create table public.x_bookmarks (
  id uuid primary key default gen_random_uuid(),
  account_username text not null check (account_username ~ '^[a-z0-9_]{1,15}$'),
  post_id text not null check (post_id ~ '^[0-9]{1,25}$'),
  url text not null check (url = 'https://x.com/i/status/' || post_id),
  title text not null check (length(title) <= 180),
  description text not null default '' check (length(description) <= 30000),
  author text not null default '',
  image_url text check (image_url is null or image_url ~ '^https://(pbs|video)\.twimg\.com/'),
  embedding vector(384),
  image_embedding vector(512),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_username, post_id)
);
alter table public.x_bookmarks enable row level security;
revoke all on public.x_bookmarks from anon, authenticated;
grant all on public.x_bookmarks to service_role;
create index x_bookmarks_created on public.x_bookmarks (created_at desc, id desc);
create index x_bookmarks_text on public.x_bookmarks using gin (to_tsvector('english', title || ' ' || description || ' ' || author));
create index x_bookmarks_vectors on public.x_bookmarks using hnsw (embedding vector_cosine_ops);
create or replace function public.update_x_bookmark_vectors() returns trigger language plpgsql set search_path = public as $$
begin
  if new.title is distinct from old.title or new.description is distinct from old.description or new.author is distinct from old.author then
    new.embedding := null;
  end if;
  if new.image_url is distinct from old.image_url then new.image_embedding := null; end if;
  -- Vector-only writes must not invalidate each other or change the content version.
  if new.title is distinct from old.title or new.description is distinct from old.description or new.author is distinct from old.author or new.image_url is distinct from old.image_url then
    new.updated_at := now();
  end if;
  return new;
end; $$;
create trigger x_bookmarks_updated before update on public.x_bookmarks for each row execute function public.update_x_bookmark_vectors();
create or replace function public.search_x_bookmarks(search_query text, query_embedding vector(384) default null, match_count integer default 100)
returns table (title text, url text, account_username text, image_url text, description text, author text, similarity double precision, keyword_score double precision, score double precision)
language sql stable security invoker set search_path = public as $$
  with ranked as (
    select b.*, case when to_tsvector('english', b.title || ' ' || b.description || ' ' || b.author) @@ websearch_to_tsquery('english', search_query)
      or position(lower(search_query) in lower(b.title || ' ' || b.description || ' ' || b.author)) > 0 then 0.8 else 0.0 end as kw,
      case when query_embedding is not null and b.embedding is not null then 1 - (b.embedding <=> query_embedding) else 0 end as sem
    from public.x_bookmarks b
  )
  select r.title, r.url, r.account_username, r.image_url, r.description, r.author, r.sem::double precision, r.kw::double precision,
    (0.75 * r.kw + 0.25 * greatest(0, r.sem))::double precision as score
  from ranked r where r.kw > 0 or r.sem >= 0.5
  order by score desc, r.created_at desc limit greatest(1, least(match_count, 1000));
$$;
revoke all on function public.search_x_bookmarks(text, vector, integer) from public, anon, authenticated;
grant execute on function public.search_x_bookmarks(text, vector, integer) to service_role;
