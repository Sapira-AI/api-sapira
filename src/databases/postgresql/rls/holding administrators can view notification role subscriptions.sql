DROP POLICY IF EXISTS "holding administrators can view notification role subscriptions" ON "public"."notification_role_subscriptions";

CREATE POLICY "holding administrators can view notification role subscriptions"
ON "public"."notification_role_subscriptions"
AS PERMISSIVE
FOR SELECT
TO public
USING (((holding_id = get_current_user_holding_id()) AND (rls_is_super_admin() OR rls_is_holding_admin())));
