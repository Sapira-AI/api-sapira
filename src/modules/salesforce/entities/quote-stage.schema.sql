create table public.quote_stages (
  id uuid not null default gen_random_uuid (),
  holding_id uuid not null,
  name text not null,
  position integer not null default 0,
  is_system_stage boolean not null default false,
  is_deletable boolean not null default true,
  color text null default '#3B82F6'::text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint quote_stages_pkey primary key (id),
  constraint quote_stages_holding_id_name_key unique (holding_id, name),
  constraint quote_stages_holding_id_position_key unique (holding_id, "position"),
  constraint quote_stages_holding_id_fkey foreign KEY (holding_id) references company_holdings (id) on delete CASCADE
) TABLESPACE pg_default;

create trigger update_quote_stages_updated_at BEFORE
update on quote_stages for EACH row
execute FUNCTION update_quote_stages_updated_at ();