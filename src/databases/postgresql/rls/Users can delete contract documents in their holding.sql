DROP POLICY IF EXISTS "Users can delete contract documents in their holding" ON "public"."contract_documents";

CREATE POLICY "Users can delete contract documents in their holding"
ON "public"."contract_documents"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
