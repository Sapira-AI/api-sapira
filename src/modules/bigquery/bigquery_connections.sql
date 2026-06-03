create table public.bigquery_connections (
  id uuid not null default gen_random_uuid (),
  holding_id uuid not null,
  user_id uuid not null,
  name text not null,
  project_id text not null,
  credentials text not null,
  dataset_id text null,
  is_active boolean null default true,
  last_sync_at timestamp with time zone null,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  constraint bigquery_connections_pkey primary key (id),
  constraint bigquery_connections_holding_id_name_key unique (holding_id, name),
  constraint bigquery_connections_holding_id_fkey foreign KEY (holding_id) references company_holdings (id) on delete CASCADE,
  constraint bigquery_connections_user_id_fkey foreign KEY (user_id) references auth.users (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists idx_bigquery_connections_holding_id on public.bigquery_connections using btree (holding_id) TABLESPACE pg_default;

create index IF not exists idx_bigquery_connections_user_id on public.bigquery_connections using btree (user_id) TABLESPACE pg_default;

create index IF not exists idx_bigquery_connections_is_active on public.bigquery_connections using btree (is_active) TABLESPACE pg_default;

create trigger set_bigquery_connections_updated_at BEFORE
update on bigquery_connections for EACH row
execute FUNCTION update_bigquery_connections_updated_at ();