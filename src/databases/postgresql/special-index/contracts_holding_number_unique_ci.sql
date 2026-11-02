-- Índice de public.contracts que TypeORM no puede declarar con @Index (expresión lower() en lugar de
-- una columna). Creado por la migración 1792510000000-ContractNumberUniqueCaseInsensitive; definición verbatim.

CREATE UNIQUE INDEX IF NOT EXISTS contracts_holding_number_unique_ci ON public.contracts USING btree (holding_id, lower(contract_number)) WHERE (deleted_at IS NULL);
