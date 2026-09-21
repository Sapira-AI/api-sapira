DROP TRIGGER IF EXISTS "set_bigquery_connections_updated_at" ON "public"."bigquery_connections";

CREATE TRIGGER set_bigquery_connections_updated_at BEFORE UPDATE ON public.bigquery_connections FOR EACH ROW EXECUTE FUNCTION update_bigquery_connections_updated_at();
