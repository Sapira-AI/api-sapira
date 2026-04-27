DROP POLICY IF EXISTS "tenant_isolation_select_mrr_adjustments" ON "public"."mrr_adjustments";

CREATE POLICY "tenant_isolation_select_mrr_adjustments"
ON "public"."mrr_adjustments"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
