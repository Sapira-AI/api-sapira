DROP TRIGGER IF EXISTS "update_stripe_connections_updated_at" ON "public"."stripe_connections";

CREATE TRIGGER "update_stripe_connections_updated_at"
BEFORE UPDATE
ON "public"."stripe_connections"
FOR EACH ROW
EXECUTE FUNCTION update_stripe_updated_at_column();
