DROP POLICY IF EXISTS "Users can insert bigquery connections for their holding" ON "public"."bigquery_connections";

CREATE POLICY "Users can insert bigquery connections for their holding"
ON "public"."bigquery_connections"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
