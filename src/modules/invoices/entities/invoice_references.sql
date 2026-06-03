create table public.invoice_references (
  id uuid not null default gen_random_uuid (),
  invoice_id uuid not null,
  holding_id uuid not null,
  document_number text not null,
  document_type_code text not null,
  document_type_name text null,
  reference_code text null,
  reason text null,
  reference_date date null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  created_by uuid null,
  constraint invoice_references_pkey primary key (id),
  constraint invoice_references_created_by_fkey foreign KEY (created_by) references auth.users (id),
  constraint invoice_references_invoice_id_fkey foreign KEY (invoice_id) references invoices (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists idx_invoice_references_invoice_id on public.invoice_references using btree (invoice_id) TABLESPACE pg_default;

create index IF not exists idx_invoice_references_holding_id on public.invoice_references using btree (holding_id) TABLESPACE pg_default;

create trigger trg_invoice_references_updated_at BEFORE
update on invoice_references for EACH row
execute FUNCTION set_updated_at ();