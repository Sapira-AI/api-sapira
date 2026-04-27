DROP POLICY IF EXISTS "financial_managers_can_insert_bank_accounts" ON "public"."company_bank_accounts";

CREATE POLICY "financial_managers_can_insert_bank_accounts"
ON "public"."company_bank_accounts"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (((holding_id = get_current_user_holding_id()) AND can_manage_financial_data()));
