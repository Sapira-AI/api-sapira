DROP POLICY IF EXISTS "Users can view RAG documents from their holding" ON "public"."rag_documents";

CREATE POLICY "Users can view RAG documents from their holding"
ON "public"."rag_documents"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
