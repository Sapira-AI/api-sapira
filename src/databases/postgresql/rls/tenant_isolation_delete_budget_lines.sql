-- Presupuestos (migración 1790750000000-Budgets, NO aplicada al 02-10): holding de la línea y de su presupuesto (misma regla que contract_item_pauses).
DROP POLICY IF EXISTS "tenant_isolation_delete_budget_lines" ON "public"."budget_lines";

CREATE POLICY "tenant_isolation_delete_budget_lines"
ON "public"."budget_lines"
AS PERMISSIVE
FOR DELETE
TO public
USING (((holding_id = get_current_user_holding_id()) AND (budget_id IN ( SELECT budgets.id
   FROM budgets
  WHERE (budgets.holding_id = get_current_user_holding_id())))));
