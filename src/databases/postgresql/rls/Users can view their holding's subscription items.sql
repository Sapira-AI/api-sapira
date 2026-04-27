DROP POLICY IF EXISTS "Users can view their holding's subscription items" ON "public"."subscription_items";

CREATE POLICY "Users can view their holding's subscription items"
ON "public"."subscription_items"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
