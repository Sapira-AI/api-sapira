DROP POLICY IF EXISTS "Users can view bigquery connections in their holding" ON "public"."bigquery_connections";

CREATE POLICY "Users can view bigquery connections in their holding"
ON "public"."bigquery_connections"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
