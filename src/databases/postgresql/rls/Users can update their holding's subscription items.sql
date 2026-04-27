DROP POLICY IF EXISTS "Users can update their holding's subscription items" ON "public"."subscription_items";

CREATE POLICY "Users can update their holding's subscription items"
ON "public"."subscription_items"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()));
