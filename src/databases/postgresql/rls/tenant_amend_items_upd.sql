DROP POLICY IF EXISTS "tenant_amend_items_upd" ON "public"."contract_amendment_items";

CREATE POLICY "tenant_amend_items_upd"
ON "public"."contract_amendment_items"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()));
