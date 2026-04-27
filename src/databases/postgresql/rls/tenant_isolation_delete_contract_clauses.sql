DROP POLICY IF EXISTS "tenant_isolation_delete_contract_clauses" ON "public"."contract_clauses";

CREATE POLICY "tenant_isolation_delete_contract_clauses"
ON "public"."contract_clauses"
AS PERMISSIVE
FOR DELETE
TO authenticated
USING ((holding_id = get_current_user_holding_id()));
