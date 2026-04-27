DROP POLICY IF EXISTS "tenant_isolation_select_invoice_reschedules" ON "public"."invoice_reschedules";

CREATE POLICY "tenant_isolation_select_invoice_reschedules"
ON "public"."invoice_reschedules"
AS PERMISSIVE
FOR SELECT
TO public
USING ((holding_id IN ( SELECT uh.holding_id
   FROM (user_holdings uh
     JOIN users u ON ((u.id = uh.user_id)))
  WHERE (u.auth_id = auth.uid()))));
