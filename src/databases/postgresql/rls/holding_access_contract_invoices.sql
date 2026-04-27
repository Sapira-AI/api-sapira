DROP POLICY IF EXISTS "holding_access_contract_invoices" ON "public"."contract_invoices";

CREATE POLICY "holding_access_contract_invoices"
ON "public"."contract_invoices"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
