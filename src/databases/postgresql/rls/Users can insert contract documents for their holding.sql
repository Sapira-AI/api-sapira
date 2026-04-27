DROP POLICY IF EXISTS "Users can insert contract documents for their holding" ON "public"."contract_documents";

CREATE POLICY "Users can insert contract documents for their holding"
ON "public"."contract_documents"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
