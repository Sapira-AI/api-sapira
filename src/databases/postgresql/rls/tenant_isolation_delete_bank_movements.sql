DROP POLICY IF EXISTS "tenant_isolation_delete_bank_movements" ON "public"."bank_movements";

CREATE POLICY "tenant_isolation_delete_bank_movements"
ON "public"."bank_movements"
AS PERMISSIVE
FOR DELETE
TO authenticated
USING ((holding_id = get_current_user_holding_id()));
