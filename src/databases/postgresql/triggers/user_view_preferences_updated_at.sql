DROP TRIGGER IF EXISTS "user_view_preferences_updated_at" ON "public"."user_view_preferences";

CREATE TRIGGER user_view_preferences_updated_at BEFORE UPDATE ON public.user_view_preferences FOR EACH ROW EXECUTE FUNCTION update_user_view_preferences_updated_at();
