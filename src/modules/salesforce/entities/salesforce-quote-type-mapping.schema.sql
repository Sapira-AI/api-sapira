create table public.salesforce_quote_type_mappings (
  id uuid not null default gen_random_uuid (),
  holding_id uuid not null,
  salesforce_type text not null,
  sapira_quote_type text not null,
  is_active boolean null default true,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  constraint salesforce_quote_type_mappings_pkey primary key (id),
  constraint unique_salesforce_type_per_holding unique (holding_id, salesforce_type),
  constraint salesforce_quote_type_mappings_holding_id_fkey foreign KEY (holding_id) references company_holdings (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists idx_sf_quote_type_mappings_holding on public.salesforce_quote_type_mappings using btree (holding_id) TABLESPACE pg_default;

create index IF not exists idx_sf_quote_type_mappings_active on public.salesforce_quote_type_mappings using btree (holding_id, is_active) TABLESPACE pg_default;

create trigger update_salesforce_quote_type_mappings_updated_at BEFORE
update on salesforce_quote_type_mappings for EACH row
execute FUNCTION update_updated_at_column ();