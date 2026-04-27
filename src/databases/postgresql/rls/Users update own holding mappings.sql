DROP POLICY IF EXISTS "Users update own holding mappings" ON "public"."company_account_mappings";

CREATE POLICY "Users update own holding mappings"
ON "public"."company_account_mappings"
AS PERMISSIVE
FOR UPDATE
TO public
USING ((company_id IN ( SELECT companies.id
   FROM companies
  WHERE (companies.holding_id = ( SELECT companies.holding_id
           FROM users
          WHERE (users.id = auth.uid()))))));
