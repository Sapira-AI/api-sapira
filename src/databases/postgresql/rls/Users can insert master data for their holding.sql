DROP POLICY IF EXISTS "Users can insert master data for their holding" ON "public"."master_data";

CREATE POLICY "Users can insert master data for their holding"
ON "public"."master_data"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((holding_id IN ( SELECT uh.holding_id
   FROM (user_holdings uh
     JOIN users u ON ((u.id = uh.user_id)))
  WHERE (u.auth_id = auth.uid()))));
