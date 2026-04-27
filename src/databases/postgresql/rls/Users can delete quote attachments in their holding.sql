DROP POLICY IF EXISTS "Users can delete quote attachments in their holding" ON "public"."quote_attachments";

CREATE POLICY "Users can delete quote attachments in their holding"
ON "public"."quote_attachments"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
