DROP POLICY IF EXISTS "Users can manage field mappings in their holding" ON "public"."salesforce_field_mappings";

CREATE POLICY "Users can manage field mappings in their holding"
ON "public"."salesforce_field_mappings"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))))
WITH CHECK ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
