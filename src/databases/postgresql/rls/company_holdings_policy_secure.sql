DROP POLICY IF EXISTS "company_holdings_policy_secure" ON "public"."company_holdings";

CREATE POLICY "company_holdings_policy_secure"
ON "public"."company_holdings"
AS PERMISSIVE
FOR ALL
TO public
USING ((id = get_current_user_holding_id()));
