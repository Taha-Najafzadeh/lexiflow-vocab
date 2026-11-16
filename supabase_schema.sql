-- Run this in your free Supabase SQL Editor to enable cross-device sync
create table if not exists public.vocab_sync (
  sync_id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.vocab_sync enable row level security;

create policy "Allow public read/write by sync_id"
  on public.vocab_sync
  for all
  using (true)
  with check (true);
