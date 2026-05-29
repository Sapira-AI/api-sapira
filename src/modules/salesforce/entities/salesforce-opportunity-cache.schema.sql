create table public.salesforce_opportunities_cache (
  id uuid not null default gen_random_uuid (),
  holding_id uuid not null,
  salesforce_id text not null,
  salesforce_account_id text null,
  opportunity_name text not null,
  account_name text null,
  account_country text null,
  opportunity_type text null,
  stage_name text null,
  is_won boolean null default false,
  is_closed boolean null default false,
  amount numeric(15, 2) null,
  currency_iso_code text null default 'USD'::text,
  close_date date null,
  id_largo_oportunidad__c text null,
  modalidad_de_pago__c text null,
  forma_de_pago__c text null,
  contrato__c text null,
  orden_de_compra__c text null,
  quote_project_manager__c text null,
  quote_billing_email__c text null,
  line_items_count integer null default 0,
  line_items jsonb null,
  sync_date date not null default CURRENT_DATE,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  constraint salesforce_opportunities_cache_pkey primary key (id),
  constraint salesforce_opportunities_cache_holding_id_fkey foreign KEY (holding_id) references company_holdings (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists idx_sf_opp_cache_holding_id on public.salesforce_opportunities_cache using btree (holding_id) TABLESPACE pg_default;

create index IF not exists idx_sf_opp_cache_sync_date on public.salesforce_opportunities_cache using btree (sync_date desc) TABLESPACE pg_default;

create index IF not exists idx_sf_opp_cache_salesforce_id on public.salesforce_opportunities_cache using btree (salesforce_id) TABLESPACE pg_default;

create index IF not exists idx_sf_opp_cache_close_date on public.salesforce_opportunities_cache using btree (close_date desc) TABLESPACE pg_default;

create unique INDEX IF not exists idx_sf_opp_cache_unique on public.salesforce_opportunities_cache using btree (holding_id, salesforce_id) TABLESPACE pg_default;

create trigger set_salesforce_opportunities_cache_updated_at BEFORE
update on salesforce_opportunities_cache for EACH row
execute FUNCTION update_salesforce_opportunities_cache_updated_at ();