DROP POLICY IF EXISTS "events_select" ON "public"."accounting_period_events";

CREATE POLICY "events_select"
ON "public"."accounting_period_events"
AS PERMISSIVE
FOR SELECT
TO public
USING ((rls_is_super_admin() OR (holding_id = get_current_user_holding_id())));
