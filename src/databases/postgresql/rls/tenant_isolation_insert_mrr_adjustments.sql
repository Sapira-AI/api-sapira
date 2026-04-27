DROP POLICY IF EXISTS "tenant_isolation_insert_mrr_adjustments" ON "public"."mrr_adjustments";

CREATE POLICY "tenant_isolation_insert_mrr_adjustments"
ON "public"."mrr_adjustments"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
