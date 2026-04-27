DROP POLICY IF EXISTS "tenant_amend_items_sel" ON "public"."contract_amendment_items";

CREATE POLICY "tenant_amend_items_sel"
ON "public"."contract_amendment_items"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
