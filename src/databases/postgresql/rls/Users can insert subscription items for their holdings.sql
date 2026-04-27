DROP POLICY IF EXISTS "Users can insert subscription items for their holdings" ON "public"."subscription_items";

CREATE POLICY "Users can insert subscription items for their holdings"
ON "public"."subscription_items"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
