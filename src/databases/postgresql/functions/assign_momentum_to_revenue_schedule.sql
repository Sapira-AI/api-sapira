CREATE OR REPLACE FUNCTION public.assign_momentum_to_revenue_schedule()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_item_categoria TEXT;
  v_item_start_date DATE;
  v_is_first_period BOOLEAN;
BEGIN
  IF NEW.momentum IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.contract_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ci.categoria, ci.start_date
  INTO v_item_categoria, v_item_start_date
  FROM public.contract_items ci
  WHERE ci.id = NEW.contract_item_id;

  IF v_item_categoria IS NULL THEN
    RETURN NEW;
  END IF;

  v_is_first_period := (
    DATE_TRUNC('month', NEW.period_month) = DATE_TRUNC('month', v_item_start_date)
  );

  IF v_is_first_period THEN
    NEW.momentum := CASE
      WHEN v_item_categoria = 'RECURRENT' THEN 'NEW'
      ELSE v_item_categoria
    END;
  ELSE
    NEW.momentum := 'BOP';
  END IF;

  RETURN NEW;
END;
$function$

