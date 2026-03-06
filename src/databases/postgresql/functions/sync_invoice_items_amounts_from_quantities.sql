-- ============================================================
-- FUNCIÓN: sync_invoice_items_amounts_from_quantities
-- Creada en: migración 20260226150000_sync_invoice_items_from_quantities.sql
--
-- Objetivo: Trigger AFTER INSERT OR UPDATE en quantities.
-- Actualiza invoice_items en estado "Por Emitir" cuyos
-- billing_period_start/end contienen el período del registro
-- de quantities insertado/actualizado.
--
-- Lógica de precio:
--   - Si unit_price IS NOT NULL AND quantity IS NOT NULL:
--       amount = unit_price × quantity
--   - Si solo amount: unit_price = amount, quantity = 1
--
-- Normalización tax_rate: acepta porcentaje (19) o decimal (0.19)
-- No interfiere con facturas legacy ni con revenue schedule mensual.
-- ============================================================

CREATE OR REPLACE FUNCTION public.sync_invoice_items_amounts_from_quantities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_item         RECORD;
  v_unit_price   NUMERIC;
  v_quantity     NUMERIC;
  v_tax_rate     NUMERIC;
  v_subtotal_cc  NUMERIC;
  v_tax_cc       NUMERIC;
  v_total_cc     NUMERIC;
  v_fx           NUMERIC;
BEGIN
  -- Guard: solo procesar si hay contract_item_id y al menos un valor de precio
  IF NEW.contract_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.unit_price IS NULL AND NEW.quantity IS NULL AND NEW.amount IS NULL THEN
    RETURN NEW;
  END IF;

  -- Determinar unit_price y quantity según los datos disponibles en quantities:
  --   Caso A: existen unit_price Y quantity → usar ambos
  --   Caso B: solo amount → unit_price = amount, quantity = 1
  IF NEW.unit_price IS NOT NULL AND NEW.quantity IS NOT NULL THEN
    v_unit_price := NEW.unit_price;
    v_quantity   := NEW.quantity;
  ELSIF NEW.amount IS NOT NULL THEN
    v_unit_price := NEW.amount;
    v_quantity   := 1;
  ELSE
    -- unit_price sin quantity o viceversa → no podemos calcular de forma segura
    RETURN NEW;
  END IF;

  -- Iterar sobre invoice_items cuyo período coincida y estén Por Emitir
  FOR v_item IN
    SELECT
      ii.id,
      ii.invoice_id,
      ii.discount_pct,
      ii.fx_contract_to_invoice,
      i.tax_rate
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
    WHERE ii.contract_item_id = NEW.contract_item_id
      AND ii.status = 'Por Emitir'
      AND ii.billing_period_start IS NOT NULL
      AND ii.billing_period_end   IS NOT NULL
      AND NEW.period BETWEEN ii.billing_period_start AND ii.billing_period_end
  LOOP
    BEGIN
      -- Normalizar tax_rate a factor decimal (0.19) independientemente
      -- del formato almacenado (porcentaje 19 o decimal 0.19)
      v_tax_rate := CASE
        WHEN v_item.tax_rate IS NULL THEN 0
        WHEN v_item.tax_rate > 1    THEN v_item.tax_rate / 100.0
        ELSE v_item.tax_rate
      END;

      -- FX: si no hay conversión definida, asumir 1:1
      v_fx := COALESCE(v_item.fx_contract_to_invoice, 1);

      -- Calcular montos en moneda contrato (contract currency)
      v_subtotal_cc := v_unit_price * v_quantity
                       * (1 - COALESCE(v_item.discount_pct, 0) / 100.0);
      v_tax_cc      := v_subtotal_cc * v_tax_rate;
      v_total_cc    := v_subtotal_cc + v_tax_cc;

      -- Actualizar invoice_item con montos recalculados
      UPDATE public.invoice_items
      SET
        quantity                     = v_quantity,
        unit_price_contract_currency = v_unit_price,
        subtotal_contract_currency   = v_subtotal_cc,
        tax_amount_contract_currency = v_tax_cc,
        total_contract_currency      = v_total_cc,
        -- Propagar a moneda de factura usando FX
        unit_price_invoice_currency  = ROUND(v_unit_price  / NULLIF(v_fx, 0), 2),
        subtotal_invoice_currency    = ROUND(v_subtotal_cc / NULLIF(v_fx, 0), 2),
        tax_amount_invoice_currency  = ROUND(v_tax_cc      / NULLIF(v_fx, 0), 2),
        total_invoice_currency       = ROUND(v_total_cc    / NULLIF(v_fx, 0), 2),
        updated_at                   = now()
      WHERE id = v_item.id;

      -- Recalcular totales del header de la invoice correspondiente
      -- sumando todos sus invoice_items activos
      UPDATE public.invoices
      SET
        amount_contract_currency = (
          SELECT COALESCE(SUM(subtotal_contract_currency), 0)
          FROM public.invoice_items
          WHERE invoice_id = v_item.invoice_id
        ),
        amount_invoice_currency = (
          SELECT COALESCE(SUM(subtotal_invoice_currency), 0)
          FROM public.invoice_items
          WHERE invoice_id = v_item.invoice_id
        ),
        vat = (
          SELECT COALESCE(SUM(tax_amount_invoice_currency), 0)
          FROM public.invoice_items
          WHERE invoice_id = v_item.invoice_id
        ),
        total_invoice_currency = (
          SELECT COALESCE(SUM(total_invoice_currency), 0)
          FROM public.invoice_items
          WHERE invoice_id = v_item.invoice_id
        ),
        updated_at = now()
      WHERE id = v_item.invoice_id;

    EXCEPTION WHEN OTHERS THEN
      -- Error no-fatal: loguear y continuar con el siguiente item
      RAISE WARNING 'sync_invoice_items_amounts_from_quantities: error procesando invoice_item % (invoice %): %',
        v_item.id, v_item.invoice_id, SQLERRM;
    END;
  END LOOP;

  RETURN NEW;
END;
$$;
