DROP POLICY IF EXISTS "holding_access_client_documents" ON "public"."client_documents";

CREATE POLICY "holding_access_client_documents"
ON "public"."client_documents"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
