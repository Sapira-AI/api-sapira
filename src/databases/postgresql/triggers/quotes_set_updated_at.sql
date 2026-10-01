-- Cotizaciones v2 (migración 1790650000000-QuotesV2): quotes.updated_at con la función compartida set_updated_at().
DROP TRIGGER IF EXISTS "quotes_set_updated_at" ON "public"."quotes";

CREATE TRIGGER quotes_set_updated_at BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
