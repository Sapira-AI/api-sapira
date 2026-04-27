DROP POLICY IF EXISTS "tenant_isolation_update_contract_templates" ON "public"."contract_templates";

CREATE POLICY "tenant_isolation_update_contract_templates"
ON "public"."contract_templates"
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING ((holding_id = get_current_user_holding_id()));
