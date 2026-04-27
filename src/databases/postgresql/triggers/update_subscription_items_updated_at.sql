DROP TRIGGER IF EXISTS "update_subscription_items_updated_at" ON "public"."subscription_items";

CREATE TRIGGER "update_subscription_items_updated_at"
BEFORE UPDATE
ON "public"."subscription_items"
FOR EACH ROW
EXECUTE FUNCTION update_stripe_updated_at_column();
