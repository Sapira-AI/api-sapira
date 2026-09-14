DROP POLICY IF EXISTS "Users can manage salesforce_sync_run_items in their holding" ON "public"."salesforce_sync_run_items";

CREATE POLICY "Users can manage salesforce_sync_run_items in their holding"
ON "public"."salesforce_sync_run_items"
AS PERMISSIVE
FOR ALL
TO public
USING ((run_id IN ( SELECT salesforce_sync_runs.id
   FROM salesforce_sync_runs
  WHERE (salesforce_sync_runs.holding_id IN ( SELECT user_holdings.holding_id
           FROM user_holdings
          WHERE (user_holdings.user_id = auth.uid()))))))
WITH CHECK ((run_id IN ( SELECT salesforce_sync_runs.id
   FROM salesforce_sync_runs
  WHERE (salesforce_sync_runs.holding_id IN ( SELECT user_holdings.holding_id
           FROM user_holdings
          WHERE (user_holdings.user_id = auth.uid()))))));
