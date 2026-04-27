DROP POLICY IF EXISTS "holding_access_contract_items" ON "public"."contract_items";

CREATE POLICY "holding_access_contract_items"
ON "public"."contract_items"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
