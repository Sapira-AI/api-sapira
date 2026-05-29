create table public.salesforce_product_mappings (
  id uuid not null default gen_random_uuid (),
  holding_id uuid not null,
  salesforce_product_id text not null,
  salesforce_product_name text null,
  salesforce_family text null,
  salesforce_product_code text null,
  sapira_product_id uuid not null,
  sapira_product_code text null,
  sapira_product_name text null,
  is_active boolean not null default true,
  created_at timestamp without time zone null default now(),
  updated_at timestamp without time zone null default now(),
  constraint salesforce_product_mappings_pkey primary key (id),
  constraint salesforce_product_mappings_holding_id_fkey foreign KEY (holding_id) references company_holdings (id) on delete CASCADE,
  constraint salesforce_product_mappings_sapira_product_id_fkey foreign KEY (sapira_product_id) references products (id) on delete RESTRICT
) TABLESPACE pg_default;

create unique INDEX IF not exists idx_sf_product_map_unique on public.salesforce_product_mappings using btree (holding_id, salesforce_product_id) TABLESPACE pg_default;

create index IF not exists idx_sf_product_map_sapira_product on public.salesforce_product_mappings using btree (sapira_product_id) TABLESPACE pg_default;

create index IF not exists idx_sf_product_map_family on public.salesforce_product_mappings using btree (holding_id, salesforce_family) TABLESPACE pg_default
where
  (salesforce_family is not null);

create index IF not exists idx_sf_product_map_active on public.salesforce_product_mappings using btree (holding_id, is_active) TABLESPACE pg_default
where
  (is_active = true);