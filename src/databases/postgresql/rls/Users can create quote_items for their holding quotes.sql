DROP POLICY IF EXISTS "Users can create quote_items for their holding quotes" ON "public"."quote_items";

CREATE POLICY "Users can create quote_items for their holding quotes"
ON "public"."quote_items"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
