DROP POLICY IF EXISTS "holding_access_client_contacts" ON "public"."client_contacts";

CREATE POLICY "holding_access_client_contacts"
ON "public"."client_contacts"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
