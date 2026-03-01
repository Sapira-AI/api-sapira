CREATE OR REPLACE FUNCTION public.trigger_revenue_schedule_on_contract_activation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
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
$function$;
