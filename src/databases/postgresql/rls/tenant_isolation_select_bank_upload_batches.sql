DROP POLICY IF EXISTS "tenant_isolation_select_bank_upload_batches" ON "public"."bank_upload_batches";

CREATE POLICY "tenant_isolation_select_bank_upload_batches"
ON "public"."bank_upload_batches"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING ((holding_id = get_current_user_holding_id()));
