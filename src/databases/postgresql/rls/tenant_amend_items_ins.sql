DROP POLICY IF EXISTS "tenant_amend_items_ins" ON "public"."contract_amendment_items";

CREATE POLICY "tenant_amend_items_ins"
ON "public"."contract_amendment_items"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
