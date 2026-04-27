DROP POLICY IF EXISTS "Users can delete their holding email sender settings" ON "public"."holding_email_sender_settings";

CREATE POLICY "Users can delete their holding email sender settings"
ON "public"."holding_email_sender_settings"
AS PERMISSIVE
FOR DELETE
TO public
USING ((holding_id IN ( SELECT user_holdings.holding_id
   FROM user_holdings
  WHERE (user_holdings.user_id = ( SELECT users.id
           FROM users
          WHERE (users.auth_id = auth.uid()))))));
