DROP POLICY IF EXISTS "tenant_isolation_insert_bank_upload_batches" ON "public"."bank_upload_batches";

CREATE POLICY "tenant_isolation_insert_bank_upload_batches"
ON "public"."bank_upload_batches"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK ((holding_id = get_current_user_holding_id()));
