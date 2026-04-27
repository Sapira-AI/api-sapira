DROP POLICY IF EXISTS "tenant_isolation_insert_contract_templates" ON "public"."contract_templates";

CREATE POLICY "tenant_isolation_insert_contract_templates"
ON "public"."contract_templates"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK ((holding_id = get_current_user_holding_id()));
