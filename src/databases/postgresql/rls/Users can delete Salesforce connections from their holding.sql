DROP POLICY IF EXISTS "Users can delete Salesforce connections from their holding" ON "public"."salesforce_connections";

CREATE POLICY "Users can delete Salesforce connections from their holding"
ON "public"."salesforce_connections"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
