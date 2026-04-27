DROP POLICY IF EXISTS "Users can view quote_items from their holding quotes" ON "public"."quote_items";

CREATE POLICY "Users can view quote_items from their holding quotes"
ON "public"."quote_items"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
