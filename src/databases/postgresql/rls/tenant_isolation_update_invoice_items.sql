DROP POLICY IF EXISTS "tenant_isolation_update_invoice_items" ON "public"."invoice_items";

CREATE POLICY "tenant_isolation_update_invoice_items"
ON "public"."invoice_items"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id IN ( SELECT uh.holding_id
   FROM (user_holdings uh
     JOIN users u ON ((u.id = uh.user_id)))
  WHERE (u.auth_id = auth.uid()))));
