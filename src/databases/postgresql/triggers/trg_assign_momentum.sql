DROP TRIGGER IF EXISTS "trg_assign_momentum" ON "public"."revenue_schedule_monthly";

CREATE TRIGGER trg_assign_momentum BEFORE INSERT OR UPDATE OF contract_item_id, period_month ON public.revenue_schedule_monthly FOR EACH ROW EXECUTE FUNCTION assign_momentum_to_revenue_schedule();
