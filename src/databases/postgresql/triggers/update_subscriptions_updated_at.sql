DROP TRIGGER IF EXISTS "update_subscriptions_updated_at" ON "public"."subscriptions";

CREATE TRIGGER "update_subscriptions_updated_at"
BEFORE UPDATE
ON "public"."subscriptions"
FOR EACH ROW
EXECUTE FUNCTION update_stripe_updated_at_column();
