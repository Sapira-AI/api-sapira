DROP POLICY IF EXISTS "tenant_isolation_insert_bank_movements" ON "public"."bank_movements";

CREATE POLICY "tenant_isolation_insert_bank_movements"
ON "public"."bank_movements"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK ((holding_id = get_current_user_holding_id()));
