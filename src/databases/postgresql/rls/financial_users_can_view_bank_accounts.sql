DROP POLICY IF EXISTS "financial_users_can_view_bank_accounts" ON "public"."company_bank_accounts";

CREATE POLICY "financial_users_can_view_bank_accounts"
ON "public"."company_bank_accounts"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (((holding_id = get_current_user_holding_id()) AND can_access_financial_data()));
