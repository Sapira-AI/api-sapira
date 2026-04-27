DROP POLICY IF EXISTS "financial_managers_can_delete_bank_accounts" ON "public"."company_bank_accounts";

CREATE POLICY "financial_managers_can_delete_bank_accounts"
ON "public"."company_bank_accounts"
AS PERMISSIVE
FOR DELETE
TO authenticated
USING (((holding_id = get_current_user_holding_id()) AND can_manage_financial_data()));
