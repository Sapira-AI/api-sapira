DROP POLICY IF EXISTS "Users can update contract documents in their holding" ON "public"."contract_documents";

CREATE POLICY "Users can update contract documents in their holding"
ON "public"."contract_documents"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()))
WITH CHECK ((holding_id = get_current_user_holding_id()));
