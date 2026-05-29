create table public.quote_items (
  id uuid not null default gen_random_uuid (),
  quote_id uuid null,
  product_id uuid null,
  product_name text not null,
  term_months integer null,
  currency text null,
  price numeric null,
  discount_type text null,
  discount_value numeric null,
  final_price numeric null,
  billing_method text null,
  billing_frequency text null,
  holding_id uuid not null default gen_random_uuid (),
  start_date date null,
  end_date date null,
  is_recurring boolean not null default true,
  item_type character varying(64) null,
  unit_of_measure character varying(32) null,
  unit_price numeric(18, 6) null,
  quantity numeric(18, 6) null,
  account character varying(128) null,
  custom_fields jsonb null default '{}'::jsonb,
  quote_item_number text null,
  data_source text null,
  salesforce_product_id text null,
  salesforce_line_item_id text null,
  monthly_price numeric(18, 2) null,
  billing_period_price numeric(18, 2) null,
  auto_renew boolean not null default false,
  auto_renew_term_months integer null,
  annual_unit_price numeric(18, 6) null,
  annual_price numeric(18, 2) null,
  price_entry_mode text null default 'monthly'::text,
  constraint quote_items_pkey primary key (id),
  constraint fk_quote_items_holding_id foreign KEY (holding_id) references company_holdings (id) on delete CASCADE,
  constraint quote_items_product_id_fkey foreign KEY (product_id) references products (id),
  constraint quote_items_quote_id_fkey foreign KEY (quote_id) references quotes (id) on delete CASCADE,
  constraint quote_items_discount_type_check check (
    (
      discount_type = any (array['Monto fijo'::text, 'Porcentaje'::text])
    )
  ),
  constraint quote_items_billing_frequency_check check (
    (
      billing_frequency = any (
        array[
          'Mensual'::text,
          'Anual'::text,
          'Semestral'::text,
          'Trimestral'::text,
          'Bianual'::text
        ]
      )
    )
  ),
  constraint quote_items_billing_method_check check (
    (
      billing_method = any (array['Anticipado'::text, 'Vencido'::text])
    )
  ),
  constraint chk_quote_items_price_entry_mode check (
    (
      price_entry_mode = any (array['monthly'::text, 'annual'::text])
    )
  )
) TABLESPACE pg_default;

create index IF not exists idx_quote_items_holding_id on public.quote_items using btree (holding_id) TABLESPACE pg_default;

create index IF not exists idx_quote_items_custom_fields on public.quote_items using gin (custom_fields) TABLESPACE pg_default;

create index IF not exists idx_quote_items_quote_item_number on public.quote_items using btree (quote_item_number) TABLESPACE pg_default
where
  (quote_item_number is not null);

create unique INDEX IF not exists idx_quote_items_quote_item_number_unique on public.quote_items using btree (quote_item_number) TABLESPACE pg_default
where
  (quote_item_number is not null);

create index IF not exists idx_quote_items_sf_product on public.quote_items using btree (salesforce_product_id) TABLESPACE pg_default
where
  (salesforce_product_id is not null);

create index IF not exists idx_quote_items_salesforce_line_item_id on public.quote_items using btree (salesforce_line_item_id) TABLESPACE pg_default
where
  (salesforce_line_item_id is not null);

create unique INDEX IF not exists idx_quote_items_salesforce_line_item_unique on public.quote_items using btree (salesforce_line_item_id) TABLESPACE pg_default
where
  (salesforce_line_item_id is not null);

create trigger trg_quote_items_calculate_pricing BEFORE INSERT
or
update OF unit_price,
quantity,
billing_frequency,
is_recurring,
final_price,
term_months,
discount_type,
discount_value,
annual_unit_price,
price_entry_mode on quote_items for EACH row
execute FUNCTION auto_calculate_pricing_fields ();