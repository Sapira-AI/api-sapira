DROP POLICY IF EXISTS "events_insert" ON "public"."accounting_period_events";

CREATE POLICY "events_insert"
ON "public"."accounting_period_events"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK (((rls_is_super_admin() OR rls_is_holding_admin()) AND (rls_is_super_admin() OR (holding_id = get_current_user_holding_id()))));
