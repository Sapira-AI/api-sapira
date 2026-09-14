DROP TRIGGER IF EXISTS "trg_contract_items_calculate_pricing" ON "public"."contract_items";

CREATE TRIGGER trg_contract_items_calculate_pricing BEFORE INSERT OR UPDATE OF unit_price, quantity, billing_frequency, is_recurring, final_price, term_months, discount_type, discount_value, annual_unit_price, price_entry_mode ON public.contract_items FOR EACH ROW EXECUTE FUNCTION auto_calculate_pricing_fields();
