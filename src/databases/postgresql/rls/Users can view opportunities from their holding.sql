DROP POLICY IF EXISTS "Users can view opportunities from their holding" ON "public"."salesforce_opportunities_cache";

CREATE POLICY "Users can view opportunities from their holding"
ON "public"."salesforce_opportunities_cache"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
