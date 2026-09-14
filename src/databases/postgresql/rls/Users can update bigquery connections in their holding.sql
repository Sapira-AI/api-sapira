DROP POLICY IF EXISTS "Users can update bigquery connections in their holding" ON "public"."bigquery_connections";

CREATE POLICY "Users can update bigquery connections in their holding"
ON "public"."bigquery_connections"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()))
WITH CHECK ((holding_id = get_current_user_holding_id()));
