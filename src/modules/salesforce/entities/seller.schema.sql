create table public.sellers (
  id uuid not null default gen_random_uuid (),
  name text not null,
  email text not null,
  phone text null,
  holding_id uuid not null,
  is_active boolean not null default true,
  created_at timestamp without time zone not null default now(),
  constraint sellers_pkey primary key (id),
  constraint fk_sellers_holding_id foreign KEY (holding_id) references company_holdings (id) on delete CASCADE
) TABLESPACE pg_default;