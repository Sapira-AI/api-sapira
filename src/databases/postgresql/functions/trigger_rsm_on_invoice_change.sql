CREATE OR REPLACE FUNCTION public.trigger_rsm_on_invoice_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enabled boolean := false;
  v_contract_status text;
  v_affected_month date;
  v_old_status text;
  v_new_status text;
  v_invoice_id uuid;
  v_header_contract_id uuid;
  v_rec RECORD;
BEGIN
  -- Costura sapira.writer: en una transacción de la API (v2) este trigger no hace nada; la API escribe cada campo.
  -- El front viejo nunca fija la marca: para él el trigger sigue igual. Regla: docs/reglas-desarrollo/logica-en-api-triggers.md
  IF current_setting('sapira.writer', true) = 'api' THEN
    RETURN NULL;  -- AFTER: el valor de retorno se ignora
  END IF;

  -- U9: la configuración del holding del registro, no la del usuario de sesión (sin sesión —webhook Odoo, DWH, cron— el
  -- holding de sesión es NULL y el RSM no se actualizaba).
  SELECT revenue_schedule_monthly_enabled INTO v_enabled
  FROM financial_settings
  WHERE holding_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.holding_id ELSE NEW.holding_id END
  LIMIT 1;

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_old_status := CASE WHEN TG_OP = 'DELETE' THEN OLD.status ELSE COALESCE(OLD.status, '') END;
  v_new_status := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.status END;

  IF TG_OP = 'UPDATE' THEN
    -- Salir si ningún campo que impacta RSM cambió
    IF  v_old_status = v_new_status
    AND OLD.issue_date IS NOT DISTINCT FROM NEW.issue_date
    AND OLD.total_invoice_currency IS NOT DISTINCT FROM NEW.total_invoice_currency THEN
      RETURN NEW;
    END IF;
    -- Salir si ninguno de los dos status involucrados afecta billed_*
    -- F2: 'Emitida' agregado a ambos sets (el rebuild suma billed de facturas
    -- 'Emitida' desde FIX 1.1, y las NC nacen 'Emitida'; sin esto, el UPDATE de
    -- totales de una NC recién creada no disparaba rebuild).
    IF v_old_status NOT IN ('Emitida','Enviada','Pagada','Vencida','Anulada','Cancelada')
    AND COALESCE(v_new_status,'') NOT IN ('Emitida','Enviada','Pagada','Vencida','Anulada','Cancelada') THEN
      RETURN NEW;
    END IF;
  END IF;

  v_invoice_id         := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  v_header_contract_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.contract_id ELSE NEW.contract_id END;
  v_affected_month := DATE_TRUNC('month',
    CASE WHEN TG_OP = 'DELETE' THEN OLD.issue_date ELSE NEW.issue_date END
  )::date;

  -- Multi-contrato (facturación unificada): los contratos afectados se derivan
  -- de los ITEMS de la factura (contract_item → contrato). El contract_id del
  -- header entra como fallback (facturas sin items o con líneas libres).
  FOR v_rec IN
    SELECT DISTINCT ci.contract_id AS cid
    FROM invoice_items ii
    JOIN contract_items ci ON ci.id = ii.contract_item_id
    WHERE ii.invoice_id = v_invoice_id AND ci.contract_id IS NOT NULL
    UNION
    SELECT v_header_contract_id WHERE v_header_contract_id IS NOT NULL
  LOOP
    SELECT status INTO v_contract_status FROM contracts WHERE id = v_rec.cid;

    IF v_contract_status = 'Activo' THEN
      BEGIN
        PERFORM revenue_schedule_rebuild(v_rec.cid, v_affected_month);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'RSM rebuild failed para contrato % (trigger invoices): %', v_rec.cid, SQLERRM;
      END;
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$function$

