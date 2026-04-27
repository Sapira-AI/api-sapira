DROP POLICY IF EXISTS "holding_access_client_entities" ON "public"."client_entities";

CREATE POLICY "holding_access_client_entities"
ON "public"."client_entities"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
