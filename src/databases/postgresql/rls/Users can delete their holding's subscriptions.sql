DROP POLICY IF EXISTS "Users can delete their holding's subscriptions" ON "public"."subscriptions";

CREATE POLICY "Users can delete their holding's subscriptions"
ON "public"."subscriptions"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
