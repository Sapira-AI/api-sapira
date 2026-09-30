CREATE OR REPLACE FUNCTION public.trigger_revenue_schedule_on_contract_activation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Costura sapira.writer: en una transacción de la API (v2) este trigger no hace nada; la API escribe cada campo.
  -- El front viejo nunca fija la marca: para él el trigger sigue igual. Regla: docs/reglas-desarrollo/logica-en-api-triggers.md
  IF current_setting('sapira.writer', true) = 'api' THEN
    RETURN NULL;  -- AFTER: el valor de retorno se ignora
  END IF;

    -- Solo ejecutamos cuando el contrato cambia a estado "Activo"
    IF COALESCE(OLD.status, '') <> 'Activo' AND NEW.status = 'Activo' THEN
        BEGIN
            PERFORM revenue_schedule_rebuild(NEW.id, NULL);
            RAISE NOTICE 'Revenue schedule rebuilt after contract % activated', NEW.id;
        EXCEPTION WHEN OTHERS THEN
            -- Registramos el error pero no bloqueamos la transacción original
            RAISE NOTICE 'Error rebuilding revenue schedule on activation for contract %: %', NEW.id, SQLERRM;
        END;
    END IF;

    RETURN NEW;
END;
$function$

