DROP POLICY IF EXISTS "Users can access invoice staging data for their holdings" ON "public"."odoo_invoices_stg";

CREATE POLICY "Users can access invoice staging data for their holdings"
ON "public"."odoo_invoices_stg"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id IN ( SELECT uh.holding_id
   FROM (user_holdings uh
     JOIN users u ON ((u.id = uh.user_id)))
  WHERE (u.auth_id = auth.uid()))));
