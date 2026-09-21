DROP TRIGGER IF EXISTS "set_notification_role_subscriptions_updated_at" ON "public"."notification_role_subscriptions";

CREATE TRIGGER set_notification_role_subscriptions_updated_at BEFORE UPDATE ON public.notification_role_subscriptions FOR EACH ROW EXECUTE FUNCTION update_app_notifications_updated_at();
