DROP POLICY IF EXISTS "holding_access_invoice_items" ON "public"."invoice_items";

CREATE POLICY "holding_access_invoice_items"
ON "public"."invoice_items"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = ( SELECT get_current_user_holding_id() AS get_current_user_holding_id)))
WITH CHECK ((holding_id = ( SELECT get_current_user_holding_id() AS get_current_user_holding_id)));
