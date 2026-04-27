DROP POLICY IF EXISTS "Service role can manage all opportunities" ON "public"."salesforce_opportunities_cache";

CREATE POLICY "Service role can manage all opportunities"
ON "public"."salesforce_opportunities_cache"
AS PERMISSIVE
FOR ALL
TO public
USING (true)
WITH CHECK (true);
