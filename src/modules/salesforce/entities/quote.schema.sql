create table public.quotes (
  id uuid not null default gen_random_uuid (),
  client_id uuid null,
  client_contact_id uuid null,
  seller_id uuid null,
  quote_date date null,
  payment_terms text null,
  requires_multicompany boolean null default false,
  requires_multicurrency boolean null default false,
  currency text null,
  total_amount numeric null,
  notes text null,
  created_at timestamp without time zone null default now(),
  holding_id uuid not null,
  quote_stage_id uuid not null,
  requires_references_for_billing boolean null default false,
  requires_contract_document boolean null default false,
  quote_number text null,
  quote_type text null,
  booking_date date null,
  salesforce_opportunity_id text null,
  constraint quotes_pkey primary key (id),
  constraint fk_quotes_holding_id foreign KEY (holding_id) references company_holdings (id) on delete CASCADE,
  constraint fk_quotes_stage foreign KEY (quote_stage_id) references quote_stages (id),
  constraint quotes_client_contact_id_fkey foreign KEY (client_contact_id) references client_contacts (id),
  constraint quotes_client_id_fkey foreign KEY (client_id) references clients (id) on delete CASCADE,
  constraint quotes_seller_id_fkey1 foreign KEY (seller_id) references sellers (id)
) TABLESPACE pg_default;

create index IF not exists idx_quotes_holding_id on public.quotes using btree (holding_id) TABLESPACE pg_default;

create index IF not exists idx_quotes_quote_number on public.quotes using btree (quote_number) TABLESPACE pg_default;

create index IF not exists idx_quotes_salesforce_opportunity_id on public.quotes using btree (salesforce_opportunity_id) TABLESPACE pg_default
where
  (salesforce_opportunity_id is not null);

create unique INDEX IF not exists idx_quotes_salesforce_opportunity_unique on public.quotes using btree (salesforce_opportunity_id, holding_id) TABLESPACE pg_default
where
  (salesforce_opportunity_id is not null);