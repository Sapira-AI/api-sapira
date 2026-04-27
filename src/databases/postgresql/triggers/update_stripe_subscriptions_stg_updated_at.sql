DROP TRIGGER IF EXISTS "update_stripe_subscriptions_stg_updated_at" ON "public"."stripe_subscriptions_stg";

CREATE TRIGGER "update_stripe_subscriptions_stg_updated_at"
BEFORE UPDATE
ON "public"."stripe_subscriptions_stg"
FOR EACH ROW
EXECUTE FUNCTION update_stripe_updated_at_column();
