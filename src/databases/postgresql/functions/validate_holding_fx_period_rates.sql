CREATE OR REPLACE FUNCTION public.validate_holding_fx_period_rates()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Validar que period_end sea mayor que period_start
  IF NEW.period_end < NEW.period_start THEN
    RAISE EXCEPTION 'La fecha de fin del período debe ser posterior a la fecha de inicio';
  END IF;

  -- Validar que la tasa sea positiva
  IF NEW.rate <= 0 THEN
    RAISE EXCEPTION 'La tasa de cambio debe ser un valor positivo';
  END IF;

  -- Validar que las monedas sean diferentes
  IF NEW.from_currency = NEW.to_currency THEN
    RAISE EXCEPTION 'Las monedas de origen y destino deben ser diferentes';
  END IF;

  -- Validar que no existan períodos superpuestos para la misma combinación
  IF EXISTS (
    SELECT 1
    FROM public.holding_fx_period_rates
    WHERE id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND holding_id = NEW.holding_id
      AND from_currency = NEW.from_currency
      AND to_currency = NEW.to_currency
      AND (
        -- Verifica si hay superposición de períodos
        (NEW.period_start <= period_end AND NEW.period_end >= period_start)
      )
  ) THEN
    RAISE EXCEPTION 'Ya existe una tasa de cambio para este par de monedas en el período especificado. Los períodos no pueden superponerse.';
  END IF;

  RETURN NEW;
END;
$function$

