DROP POLICY IF EXISTS "Users can update mrr_legacy in their holding" ON "public"."mrr_legacy";

CREATE POLICY "Users can update mrr_legacy in their holding"
ON "public"."mrr_legacy"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id = get_current_user_holding_id()))
WITH CHECK ((holding_id = get_current_user_holding_id()));
