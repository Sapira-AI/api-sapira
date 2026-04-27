DROP POLICY IF EXISTS "Users can view mrr_legacy from their holding" ON "public"."mrr_legacy";

CREATE POLICY "Users can view mrr_legacy from their holding"
ON "public"."mrr_legacy"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id = get_current_user_holding_id()));
