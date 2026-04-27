DROP POLICY IF EXISTS "Users can update quote attachments in their holding" ON "public"."quote_attachments";

CREATE POLICY "Users can update quote attachments in their holding"
ON "public"."quote_attachments"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))))
WITH CHECK ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
