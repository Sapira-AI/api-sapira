DROP POLICY IF EXISTS "Users can insert quote attachments in their holding" ON "public"."quote_attachments";

CREATE POLICY "Users can insert quote attachments in their holding"
ON "public"."quote_attachments"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = auth.uid()))));
