DROP POLICY IF EXISTS "Users can insert subscriptions for their holdings" ON "public"."subscriptions";

CREATE POLICY "Users can insert subscriptions for their holdings"
ON "public"."subscriptions"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
