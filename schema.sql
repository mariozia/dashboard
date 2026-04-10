-- Outcome cache: market slug → winner
create table if not exists outcome_cache (
  slug        text primary key,
  winner      text not null,
  outcomes    jsonb,
  prices      jsonb,
  created_at  timestamptz default now()
);

-- P&L cache: conditionId → full position data
create table if not exists pnl_cache (
  condition_id  text primary key,
  data          jsonb not null,
  created_at    timestamptz default now()
);

-- Allow anon key to read and write both tables
alter table outcome_cache enable row level security;
alter table pnl_cache     enable row level security;

create policy "anon read"   on outcome_cache for select using (true);
create policy "anon insert" on outcome_cache for insert with check (true);
create policy "anon update" on outcome_cache for update using (true);

create policy "anon read"   on pnl_cache for select using (true);
create policy "anon insert" on pnl_cache for insert with check (true);
create policy "anon update" on pnl_cache for update using (true);
