DROP POLICY IF EXISTS "Users can update product mappings from their holding" ON "public"."salesforce_product_mappings";

CREATE POLICY "Users can update product mappings from their holding"
ON "public"."salesforce_product_mappings"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()))
WITH CHECK ((holding_id = get_current_user_holding_id()));
