create table public.client_contacts (
  id uuid not null default gen_random_uuid (),
  client_id uuid null,
  contact_type text null,
  name text null,
  position text null,
  email text null,
  phone text null,
  holding_id uuid not null default gen_random_uuid (),
  constraint client_contacts_pkey primary key (id),
  constraint client_contacts_client_id_fkey foreign KEY (client_id) references clients (id) on delete CASCADE,
  constraint fk_client_contacts_holding_id foreign KEY (holding_id) references company_holdings (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists idx_client_contacts_holding_id on public.client_contacts using btree (holding_id) TABLESPACE pg_default;