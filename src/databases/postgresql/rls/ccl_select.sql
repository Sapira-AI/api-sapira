DROP POLICY IF EXISTS "ccl_select" ON "public"."contract_change_log";

CREATE POLICY "ccl_select"
ON "public"."contract_change_log"
AS PERMISSIVE
FOR SELECT
TO public
USING ((rls_is_super_admin() OR (holding_id = get_current_user_holding_id())));
