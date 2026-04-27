DROP POLICY IF EXISTS "Users can update their holding's subscriptions" ON "public"."subscriptions";

CREATE POLICY "Users can update their holding's subscriptions"
ON "public"."subscriptions"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()));
