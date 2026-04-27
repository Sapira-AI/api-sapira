DROP POLICY IF EXISTS "tenant_isolation_select_bank_column_mappings" ON "public"."bank_column_mappings";

CREATE POLICY "tenant_isolation_select_bank_column_mappings"
ON "public"."bank_column_mappings"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING ((holding_id = get_current_user_holding_id()));
