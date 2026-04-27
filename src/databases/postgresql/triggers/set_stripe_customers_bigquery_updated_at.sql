DROP TRIGGER IF EXISTS "set_stripe_customers_bigquery_updated_at" ON "public"."stripe_customers_bigquery";

CREATE TRIGGER "set_stripe_customers_bigquery_updated_at"
BEFORE UPDATE
ON "public"."stripe_customers_bigquery"
FOR EACH ROW
EXECUTE FUNCTION update_stripe_customers_bigquery_updated_at();
