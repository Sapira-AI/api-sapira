DROP POLICY IF EXISTS "Users can manage salesforce_opportunities_stg in their holding" ON "public"."salesforce_opportunities_stg";

CREATE POLICY "Users can manage salesforce_opportunities_stg in their holding"
ON "public"."salesforce_opportunities_stg"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))))
WITH CHECK ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
