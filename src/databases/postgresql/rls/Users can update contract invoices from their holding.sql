DROP POLICY IF EXISTS "Users can update contract invoices from their holding" ON "public"."contract_invoices";

CREATE POLICY "Users can update contract invoices from their holding"
ON "public"."contract_invoices"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((contract_id IN ( SELECT c.id
   FROM ((contracts c
     JOIN companies comp ON ((c.company_id = comp.id)))
     JOIN user_holdings uh ON ((comp.holding_id = uh.holding_id)))
  WHERE (uh.user_id = auth.uid()))));
