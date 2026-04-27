DROP POLICY IF EXISTS "Users can delete mrr_legacy from their holding" ON "public"."mrr_legacy";

CREATE POLICY "Users can delete mrr_legacy from their holding"
ON "public"."mrr_legacy"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id = get_current_user_holding_id()));
