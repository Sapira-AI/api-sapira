DROP POLICY IF EXISTS "Users can insert contract invoices for their holding" ON "public"."contract_invoices";

CREATE POLICY "Users can insert contract invoices for their holding"
ON "public"."contract_invoices"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((contract_id IN ( SELECT c.id
   FROM ((contracts c
     JOIN companies comp ON ((c.company_id = comp.id)))
     JOIN user_holdings uh ON ((comp.holding_id = uh.holding_id)))
  WHERE (uh.user_id = auth.uid()))));
