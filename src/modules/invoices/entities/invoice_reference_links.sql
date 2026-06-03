create table public.invoice_reference_links (
  id uuid not null default gen_random_uuid (),
  invoice_id uuid not null,
  reference_id uuid not null,
  holding_id uuid not null,
  linked_at timestamp with time zone null default now(),
  linked_by uuid null,
  constraint invoice_reference_links_pkey primary key (id),
  constraint invoice_reference_links_invoice_id_reference_id_key unique (invoice_id, reference_id),
  constraint invoice_reference_links_holding_id_fkey foreign KEY (holding_id) references company_holdings (id) on delete CASCADE,
  constraint invoice_reference_links_invoice_id_fkey foreign KEY (invoice_id) references invoices (id) on delete CASCADE,
  constraint invoice_reference_links_linked_by_fkey foreign KEY (linked_by) references users (id),
  constraint invoice_reference_links_reference_id_fkey foreign KEY (reference_id) references billing_references (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists idx_invoice_reference_links_invoice on public.invoice_reference_links using btree (invoice_id) TABLESPACE pg_default;

create index IF not exists idx_invoice_reference_links_reference on public.invoice_reference_links using btree (reference_id) TABLESPACE pg_default;