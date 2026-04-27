DROP POLICY IF EXISTS "Users can delete quote_items from their holding quotes" ON "public"."quote_items";

CREATE POLICY "Users can delete quote_items from their holding quotes"
ON "public"."quote_items"
AS PERMISSIVE
FOR DELETE
TO public
USING ((EXISTS ( SELECT 1
   FROM ((quotes q
     JOIN clients c ON ((q.client_id = c.id)))
     JOIN user_holdings uh ON ((c.holding_id = uh.holding_id)))
  WHERE ((q.id = quote_items.quote_id) AND (uh.user_id = auth.uid())))));
