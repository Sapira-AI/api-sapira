DROP POLICY IF EXISTS "Users can view their holding's subscriptions" ON "public"."subscriptions";

CREATE POLICY "Users can view their holding's subscriptions"
ON "public"."subscriptions"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
