create table public.salesforce_connections (
  id uuid not null default gen_random_uuid (),
  user_id uuid null,
  username text null,
  client_id text not null,
  client_secret text not null,
  security_token text null,
  login_url text null default 'https://login.salesforce.com'::text,
  access_token text null,
  instance_url text null,
  salesforce_user_id text null,
  token_issued_at timestamp with time zone null,
  is_active boolean null default true,
  last_sync_at timestamp with time zone null,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  refresh_token text null,
  token_expires_at timestamp with time zone null,
  holding_id uuid not null,
  auth_type text null default 'client_credentials'::text,
  password text null,
  constraint salesforce_connections_pkey primary key (id),
  constraint salesforce_connections_holding_id_key unique (holding_id),
  constraint salesforce_connections_holding_id_fkey foreign KEY (holding_id) references company_holdings (id) on delete CASCADE,
  constraint salesforce_connections_user_id_fkey foreign KEY (user_id) references auth.users (id) on delete CASCADE,
  constraint salesforce_connections_auth_type_check check (
    (
      auth_type = any (
        array['password'::text, 'client_credentials'::text]
      )
    )
  )
) TABLESPACE pg_default;

create index IF not exists idx_salesforce_connections_user_id on public.salesforce_connections using btree (user_id) TABLESPACE pg_default;

create index IF not exists idx_salesforce_connections_is_active on public.salesforce_connections using btree (is_active) TABLESPACE pg_default;

create index IF not exists idx_salesforce_connections_holding_id on public.salesforce_connections using btree (holding_id) TABLESPACE pg_default;

create index IF not exists idx_salesforce_connections_auth_type on public.salesforce_connections using btree (auth_type) TABLESPACE pg_default;

create trigger set_salesforce_connections_updated_at BEFORE
update on salesforce_connections for EACH row
execute FUNCTION update_salesforce_connections_updated_at ();