create table public.salesforce_object_mappings (
  id uuid not null default gen_random_uuid (),
  holding_id uuid not null,
  salesforce_object_type text not null,
  salesforce_object_id text not null,
  sapira_table_name text not null,
  sapira_record_id uuid not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  last_synced_at timestamp with time zone not null default now(),
  constraint salesforce_object_mappings_pkey primary key (id),
  constraint unique_salesforce_object_per_holding unique (
    holding_id,
    salesforce_object_type,
    salesforce_object_id
  ),
  constraint salesforce_object_mappings_holding_id_fkey foreign KEY (holding_id) references company_holdings (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists idx_salesforce_mappings_salesforce_lookup on public.salesforce_object_mappings using btree (
  holding_id,
  salesforce_object_type,
  salesforce_object_id
) TABLESPACE pg_default;

create index IF not exists idx_salesforce_mappings_sapira_lookup on public.salesforce_object_mappings using btree (holding_id, sapira_table_name, sapira_record_id) TABLESPACE pg_default;

create index IF not exists idx_salesforce_mappings_holding on public.salesforce_object_mappings using btree (holding_id) TABLESPACE pg_default;

create trigger trigger_update_salesforce_mapping_timestamp BEFORE
update on salesforce_object_mappings for EACH row
execute FUNCTION update_salesforce_mapping_updated_at ();