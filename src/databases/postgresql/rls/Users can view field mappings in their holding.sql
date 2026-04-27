DROP POLICY IF EXISTS "Users can view field mappings in their holding" ON "public"."salesforce_field_mappings";

CREATE POLICY "Users can view field mappings in their holding"
ON "public"."salesforce_field_mappings"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
