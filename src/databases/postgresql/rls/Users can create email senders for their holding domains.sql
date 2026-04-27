DROP POLICY IF EXISTS "Users can create email senders for their holding domains" ON "public"."email_sender_addresses";

CREATE POLICY "Users can create email senders for their holding domains"
ON "public"."email_sender_addresses"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((domain_config_id IN ( SELECT holding_email_sender_settings.id
   FROM holding_email_sender_settings
  WHERE (holding_email_sender_settings.holding_id IN ( SELECT user_holdings.holding_id
           FROM user_holdings
          WHERE (user_holdings.user_id = ( SELECT users.id
                   FROM users
                  WHERE (users.auth_id = auth.uid()))))))));
