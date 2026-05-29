create table public.master_data (
  id uuid not null default gen_random_uuid (),
  holding_id uuid not null,
  category text not null,
  value text not null,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint master_data_pkey primary key (id),
  constraint master_data_holding_id_category_value_key unique (holding_id, category, value),
  constraint fk_master_data_holding_id foreign KEY (holding_id) references company_holdings (id) on delete CASCADE,
  constraint master_data_category_check check (
    (
      category = any (
        array[
          'markets'::text,
          'segments'::text,
          'industries'::text,
          'item_types'::text,
          'units_of_measure'::text,
          'quote_types'::text,
          'payment_terms'::text,
          'contact_types'::text
        ]
      )
    )
  )
) TABLESPACE pg_default;

create index IF not exists idx_master_data_holding_id on public.master_data using btree (holding_id) TABLESPACE pg_default;

create index IF not exists idx_master_data_category_active on public.master_data using btree (holding_id, category, is_active) TABLESPACE pg_default
where
  (is_active = true);