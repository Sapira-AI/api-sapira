DROP POLICY IF EXISTS "Users can view product mappings from their holding" ON "public"."salesforce_product_mappings";

CREATE POLICY "Users can view product mappings from their holding"
ON "public"."salesforce_product_mappings"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
