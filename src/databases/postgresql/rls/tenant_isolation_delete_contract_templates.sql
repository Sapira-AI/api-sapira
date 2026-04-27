DROP POLICY IF EXISTS "tenant_isolation_delete_contract_templates" ON "public"."contract_templates";

CREATE POLICY "tenant_isolation_delete_contract_templates"
ON "public"."contract_templates"
AS PERMISSIVE
FOR DELETE
TO authenticated
USING ((holding_id = get_current_user_holding_id()));
