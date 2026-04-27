DROP POLICY IF EXISTS "Users can insert Salesforce connections for their holding" ON "public"."salesforce_connections";

CREATE POLICY "Users can insert Salesforce connections for their holding"
ON "public"."salesforce_connections"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
