-- Celda única de public.budget_lines (presupuestos, migración 1790750000000-Budgets). Usa COALESCE porque un NULL en un UNIQUE normal
-- no deduplica: dos líneas `total` (dimension_id y dimension_key NULL) del mismo período se considerarían distintas.
-- La expresión hace que @Index no pueda declararlo, por eso vive acá y no en la entity.

CREATE UNIQUE INDEX IF NOT EXISTS "uq_budget_lines_cell"
	ON "budget_lines" ("budget_id", "period_start", "dimension_type", COALESCE("dimension_id", '00000000-0000-0000-0000-000000000000'::uuid), COALESCE("dimension_key", ''));
