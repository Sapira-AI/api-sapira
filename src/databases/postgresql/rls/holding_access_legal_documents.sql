DROP POLICY IF EXISTS "holding_access_legal_documents" ON "public"."company_legal_documents";

CREATE POLICY "holding_access_legal_documents"
ON "public"."company_legal_documents"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
