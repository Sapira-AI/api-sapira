CREATE OR REPLACE FUNCTION public.delete_user_complete(user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  _holding_id uuid;
BEGIN
  -- Primero obtener el holding_id asociado al usuario
  SELECT holding_id INTO _holding_id FROM public.user_holdings WHERE user_id = delete_user_complete.user_id;
  
  -- Eliminar asociaciones en user_holdings
  DELETE FROM public.user_holdings WHERE user_id = delete_user_complete.user_id;
  
  -- Eliminar asociaciones en user_companies
  DELETE FROM public.user_companies WHERE user_id = delete_user_complete.user_id;
  
  -- Eliminar el usuario de la tabla users
  DELETE FROM public.users WHERE auth_id = delete_user_complete.user_id;
  
  -- Opcionalmente, si quieres también eliminar el holding si solo pertenecía a este usuario
  -- (descomenta si quieres esta funcionalidad)
  /*
  IF _holding_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.user_holdings WHERE holding_id = _holding_id AND user_id != delete_user_complete.user_id) THEN
      DELETE FROM public.company_holdings WHERE id = _holding_id;
    END IF;
  END IF;
  */
  
  RETURN true;
END;
$function$

