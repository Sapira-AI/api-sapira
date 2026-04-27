DROP POLICY IF EXISTS "Users can insert product mappings for their holding" ON "public"."salesforce_product_mappings";

CREATE POLICY "Users can insert product mappings for their holding"
ON "public"."salesforce_product_mappings"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
