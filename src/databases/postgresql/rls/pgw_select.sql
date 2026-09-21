DROP POLICY IF EXISTS "pgw_select" ON "public"."period_guard_warnings";

CREATE POLICY "pgw_select"
ON "public"."period_guard_warnings"
AS PERMISSIVE
FOR SELECT
TO public
USING ((rls_is_super_admin() OR (holding_id = get_current_user_holding_id())));
