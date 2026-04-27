DROP POLICY IF EXISTS "tenant_isolation_insert_contract_clauses" ON "public"."contract_clauses";

CREATE POLICY "tenant_isolation_insert_contract_clauses"
ON "public"."contract_clauses"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK ((holding_id = get_current_user_holding_id()));
