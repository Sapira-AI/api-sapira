DROP POLICY IF EXISTS "cutoff_insert" ON "public"."accounting_period_cutoff";

CREATE POLICY "cutoff_insert"
ON "public"."accounting_period_cutoff"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK (((rls_is_super_admin() OR rls_is_holding_admin()) AND (rls_is_super_admin() OR (holding_id = get_current_user_holding_id()))));
