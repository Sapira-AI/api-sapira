CREATE OR REPLACE FUNCTION public.auto_populate_invoice_fx_to_system()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_system_currency TEXT;
  v_fx_policy TEXT;
  v_contract_currency TEXT;
  v_source_amount NUMERIC;
  v_fx_result RECORD;
  v_issue_date DATE;
BEGIN
  -- Costura sapira.writer: en una transacción de la API (v2) este trigger no hace nada; la API escribe cada campo.
  -- El front viejo nunca fija la marca: para él el trigger sigue igual. Regla: docs/reglas-desarrollo/logica-en-api-triggers.md
  IF current_setting('sapira.writer', true) = 'api' THEN
    RETURN NEW;
  END IF;

  -- Solo procesar si el invoice tiene contract_id
  IF NEW.contract_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Regla por estado (decisión de Domi 04-10): Por Emitir (aún no hay documento) → siempre desde la moneda de contrato, el monto del
  -- encabezado (amount_contract_currency en NEW.contract_currency; sin ella, la del contrato). Cualquier otro estado (Emitida, Enviada,
  -- Vencida, Pagada, Cancelada, NC…) → desde la moneda de factura, lo que realmente se cobra (amount_invoice_currency en
  -- invoice_currency); sin neto en moneda de factura (o neto 0 con monto en contrato ≠ 0), el encabezado. Al emitir, el UPDATE de estado
  -- recalcula aquí. Misma regla que refreshInvoiceSystemAmounts (INVOICE_SYSTEM_SOURCE_CURRENCY_SQL). v_contract_currency = moneda
  -- desde la que se convierte.
  IF NEW.status IS DISTINCT FROM 'Por Emitir'
     AND NEW.amount_invoice_currency IS NOT NULL AND NULLIF(TRIM(NEW.invoice_currency), '') IS NOT NULL
     AND (NEW.amount_invoice_currency <> 0 OR COALESCE(NEW.amount_contract_currency, 0) = 0) THEN
    v_contract_currency := UPPER(TRIM(NEW.invoice_currency));
    v_source_amount := NEW.amount_invoice_currency;
  ELSE
    SELECT UPPER(TRIM(COALESCE(NULLIF(TRIM(NEW.contract_currency), ''), c.contract_currency))) INTO v_contract_currency
    FROM public.contracts c
    WHERE c.id = NEW.contract_id;
    v_source_amount := NEW.amount_contract_currency;
  END IF;

  IF v_contract_currency IS NULL THEN
    RETURN NEW;
  END IF;

  -- Obtener system_currency y fx_system_policy del holding
  SELECT system_currency, fx_system_policy
  INTO v_system_currency, v_fx_policy
  FROM public.holding_settings
  WHERE holding_id = NEW.holding_id;

  -- Defaults si no hay configuración
  v_system_currency := COALESCE(v_system_currency, 'USD');
  v_fx_policy := COALESCE(v_fx_policy, 'monthly_avg');

  -- Si las monedas son iguales, fx = 1
  IF v_contract_currency = v_system_currency THEN
    NEW.fx_contract_to_system := 1.0;
    NEW.system_currency := v_system_currency;
    NEW.amount_system_currency := v_source_amount;
    
    -- ✅ tax_rate está en PORCENTAJE (0-100), dividir por 100
    NEW.total_system_currency := ROUND(
      NEW.amount_system_currency * (1 + COALESCE(NEW.tax_rate, 0) / 100.0),
      2
    );
    
    RETURN NEW;
  END IF;

  -- Determinar fecha para buscar FX rate
  v_issue_date := COALESCE(NEW.issue_date, NEW.scheduled_at, NEW.original_issue_date, CURRENT_DATE);

  -- Usar calculate_system_fx_rate con holding_id
  SELECT rate, source, reference_date
  INTO v_fx_result
  FROM public.calculate_system_fx_rate(
    NEW.holding_id,
    v_contract_currency,
    v_system_currency,
    v_issue_date,
    v_fx_policy
  );

  -- Asignar el FX rate encontrado
  IF v_fx_result.rate IS NOT NULL THEN
    NEW.fx_contract_to_system := v_fx_result.rate;
    NEW.system_currency := v_system_currency;
    
    -- ✅ FIX: DIVIDIR en lugar de multiplicar
    -- Los rates están configurados como inversos (1 USD = X moneda)
    -- Para convertir moneda → USD debemos DIVIDIR
    NEW.amount_system_currency := ROUND(v_source_amount / NULLIF(v_fx_result.rate, 0), 2);
    
    -- ✅ FIX: Calcular total_system desde amount_system y tax_rate en PORCENTAJE
    NEW.total_system_currency := ROUND(
      NEW.amount_system_currency * (1 + COALESCE(NEW.tax_rate, 0) / 100.0),
      2
    );
  ELSE
    -- Si no se encuentra FX rate, dejar NULL y loguear
    RAISE WARNING 'No FX rate found for holding % from % to % on date %', 
      NEW.holding_id, v_contract_currency, v_system_currency, v_issue_date;
    NEW.fx_contract_to_system := NULL;
    NEW.system_currency := v_system_currency;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public."auto_populate_invoice_fx_to_system"() IS 'Trigger que auto-completa fx_contract_to_system, system_currency, amount_system_currency y total_system_currency en invoices.
CORREGIDO: DIVIDE por fx_rate porque los rates están configurados como inversos (1 USD = X moneda).
Ejemplo: MXN 7,440 con FX 18.29 = 7,440 / 18.29 = 406.78 USD
Regla por estado (04-10): Por Emitir → amount_contract_currency en la moneda del encabezado (invoices.contract_currency; sin ella, la del contrato); cualquier otro estado → el neto en moneda de factura (amount_invoice_currency en invoice_currency), y sin él el encabezado. fx_contract_to_system guarda la tasa moneda de origen → sistema.';
