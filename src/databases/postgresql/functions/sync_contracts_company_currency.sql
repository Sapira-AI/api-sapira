CREATE OR REPLACE FUNCTION public.sync_contracts_company_currency()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    -- Only proceed if currency actually changed
    IF OLD.currency IS DISTINCT FROM NEW.currency THEN
        -- Update all contracts for this company
        UPDATE contracts 
        SET company_currency = NEW.currency
        WHERE company_id = NEW.id;
        
        RAISE NOTICE 'Updated company_currency for all contracts of company % from % to %', 
            NEW.id, OLD.currency, NEW.currency;
    END IF;
    
    RETURN NEW;
END;
$function$

