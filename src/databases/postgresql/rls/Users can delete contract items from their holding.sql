DROP POLICY IF EXISTS "Users can delete contract items from their holding" ON "public"."contract_items";

CREATE POLICY "Users can delete contract items from their holding"
ON "public"."contract_items"
AS PERMISSIVE
FOR DELETE
TO public
USING ((contract_id IN ( SELECT c.id
   FROM ((contracts c
     JOIN companies comp ON ((c.company_id = comp.id)))
     JOIN user_holdings uh ON ((comp.holding_id = uh.holding_id)))
  WHERE (uh.user_id = auth.uid()))));
