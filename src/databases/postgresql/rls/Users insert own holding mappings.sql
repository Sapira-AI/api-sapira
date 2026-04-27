DROP POLICY IF EXISTS "Users insert own holding mappings" ON "public"."company_account_mappings";

CREATE POLICY "Users insert own holding mappings"
ON "public"."company_account_mappings"
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((company_id IN ( SELECT companies.id
   FROM companies
  WHERE (companies.holding_id = ( SELECT companies.holding_id
           FROM users
          WHERE (users.id = auth.uid()))))));
