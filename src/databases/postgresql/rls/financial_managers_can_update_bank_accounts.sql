DROP POLICY IF EXISTS "financial_managers_can_update_bank_accounts" ON "public"."company_bank_accounts";

CREATE POLICY "financial_managers_can_update_bank_accounts"
ON "public"."company_bank_accounts"
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING (((holding_id = get_current_user_holding_id()) AND can_manage_financial_data()));
