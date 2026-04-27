CREATE OR REPLACE FUNCTION public.quantities_set_holding_from_contract_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract_id  uuid;
  v_item_id      uuid;
  v_holding_id   uuid;
BEGIN
  -- -------------------------------------------------------
  -- PASO 1: Resolver contract_id desde salesforce_opportunity_id
  --         Solo si contract_id no viene en el INSERT.
  -- -------------------------------------------------------
  IF NEW.contract_id IS NULL AND NEW.salesforce_opportunity_id IS NOT NULL THEN
    SELECT id
    INTO v_contract_id
    FROM public.contracts
    WHERE salesforce_opportunity_id = NEW.salesforce_opportunity_id
    LIMIT 1;

    NEW.contract_id := v_contract_id;
  END IF;

  -- -------------------------------------------------------
  -- PASO 2: Resolver contract_item_id desde salesforce_line_item_id
  --         Solo si contract_item_id no viene en el INSERT.
  --         Filtra por contract_id cuando ya está disponible
  --         para evitar colisiones entre clientes.
  -- -------------------------------------------------------
  IF NEW.contract_item_id IS NULL AND NEW.salesforce_line_item_id IS NOT NULL THEN
    SELECT ci.id
    INTO v_item_id
    FROM public.contract_items ci
    WHERE ci.quote_item_number = NEW.salesforce_line_item_id
      AND (NEW.contract_id IS NULL OR ci.contract_id = NEW.contract_id)
    ORDER BY ci.created_at DESC
    LIMIT 1;

    NEW.contract_item_id := v_item_id;
  END IF;

  -- -------------------------------------------------------
  -- PASO 3: Validar que al final tengamos un contract_item_id
  -- -------------------------------------------------------
  IF NEW.contract_item_id IS NULL THEN
    RAISE EXCEPTION
      'quantities: no se pudo resolver contract_item_id. '
      'Proveer sapira_contracts_item_id o salesforce_line_item_id válido.';
  END IF;

  -- -------------------------------------------------------
  -- PASO 4: Derivar contract_id y holding_id desde contract_items
  --         En caso de que alguno siga faltando después de los pasos anteriores.
  -- -------------------------------------------------------
  IF NEW.contract_id IS NULL OR NEW.holding_id IS NULL THEN
    SELECT ci.contract_id, c.holding_id
    INTO v_contract_id, v_holding_id
    FROM public.contract_items ci
    JOIN public.contracts c ON c.id = ci.contract_id
    WHERE ci.id = NEW.contract_item_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'quantities: contract_item_id % no encontrado en contract_items',
        NEW.contract_item_id;
    END IF;

    IF NEW.contract_id  IS NULL THEN NEW.contract_id  := v_contract_id;  END IF;
    IF NEW.holding_id   IS NULL THEN NEW.holding_id   := v_holding_id;   END IF;
  END IF;

  RETURN NEW;
END;
$function$

