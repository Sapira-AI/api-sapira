-- Clave natural de public.sapira_quantity_imports. Usa COALESCE porque un NULL en un UNIQUE
-- normal no deduplica: dos filas con quote_line_id NULL se considerarían distintas.
-- La expresión hace que @Index no pueda declararlo, por eso vive acá y no en la entity.

CREATE UNIQUE INDEX IF NOT EXISTS "sapira_quantity_imports_source_key"
	ON "sapira_quantity_imports" ("holding_id", "sf_id", "billing_date", "product", COALESCE("quote_line_id", ''));
