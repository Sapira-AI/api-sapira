DROP POLICY IF EXISTS "cutoff_select" ON "public"."accounting_period_cutoff";

CREATE POLICY "cutoff_select"
ON "public"."accounting_period_cutoff"
AS PERMISSIVE
FOR SELECT
TO public
USING ((rls_is_super_admin() OR (holding_id = get_current_user_holding_id())));
