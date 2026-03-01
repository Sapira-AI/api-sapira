CREATE OR REPLACE FUNCTION public.trigger_rsm_on_churn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_churn_period date;
BEGIN
  -- Solo actuar cuando churn_date pasa de NULL a una fecha concreta
  IF OLD.churn_date IS NOT NULL OR NEW.churn_date IS NULL THEN
    RETURN NEW;
  END IF;

  v_churn_period := DATE_TRUNC('month', NEW.churn_date)::date;

  DELETE FROM revenue_schedule_monthly
  WHERE contract_id = NEW.id
    AND period_month > v_churn_period
    AND COALESCE(is_total_row, false) = false;

  RAISE NOTICE 'RSM: eliminados períodos futuros al churn % para contrato %', v_churn_period, NEW.id;

  RETURN NEW;
END;
$$;
