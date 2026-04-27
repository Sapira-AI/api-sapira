DROP POLICY IF EXISTS "Users can insert mrr_legacy in their holding" ON "public"."mrr_legacy";

CREATE POLICY "Users can insert mrr_legacy in their holding"
ON "public"."mrr_legacy"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id = get_current_user_holding_id()));
