DROP POLICY IF EXISTS "holding_access_quote_items" ON "public"."quote_items";

CREATE POLICY "holding_access_quote_items"
ON "public"."quote_items"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
