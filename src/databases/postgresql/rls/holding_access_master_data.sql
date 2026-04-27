DROP POLICY IF EXISTS "holding_access_master_data" ON "public"."master_data";

CREATE POLICY "holding_access_master_data"
ON "public"."master_data"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
