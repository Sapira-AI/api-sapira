DROP POLICY IF EXISTS "user_holdings_policy_direct" ON "public"."user_holdings";

CREATE POLICY "user_holdings_policy_direct"
ON "public"."user_holdings"
AS PERMISSIVE
FOR ALL
TO public
USING ((user_id = get_current_user_id()));
