-- Presupuestos (migración 1790750000000-Budgets, NO aplicada al 02-10): aislamiento por holding.
DROP POLICY IF EXISTS "tenant_isolation_delete_budgets" ON "public"."budgets";

CREATE POLICY "tenant_isolation_delete_budgets"
ON "public"."budgets"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
