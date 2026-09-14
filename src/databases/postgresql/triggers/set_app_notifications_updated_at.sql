DROP TRIGGER IF EXISTS "set_app_notifications_updated_at" ON "public"."app_notifications";

CREATE TRIGGER set_app_notifications_updated_at BEFORE UPDATE ON public.app_notifications FOR EACH ROW EXECUTE FUNCTION update_app_notifications_updated_at();
