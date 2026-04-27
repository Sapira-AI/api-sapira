DROP POLICY IF EXISTS "Users can update quote_items from their holding quotes" ON "public"."quote_items";

CREATE POLICY "Users can update quote_items from their holding quotes"
ON "public"."quote_items"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()))
WITH CHECK ((holding_id = get_current_user_holding_id()));
