DROP POLICY IF EXISTS "tenant_isolation_update_invoice_adjustments" ON "public"."invoice_adjustments";

CREATE POLICY "tenant_isolation_update_invoice_adjustments"
ON "public"."invoice_adjustments"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()));
