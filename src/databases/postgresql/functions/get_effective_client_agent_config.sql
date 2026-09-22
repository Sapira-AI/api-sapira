CREATE OR REPLACE FUNCTION public.get_effective_client_agent_config(p_agent_id uuid, p_client_id uuid, p_agent_type text, p_holding_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_global_config JSONB := '{}'::jsonb;
  v_client_config RECORD;
  v_config_entry RECORD;
BEGIN
  -- 1. Obtener configuración global del agente
  FOR v_config_entry IN
    SELECT key, value_json
    FROM ai_agent_configs
    WHERE agent_id = p_agent_id
  LOOP
    v_global_config := v_global_config || jsonb_build_object(v_config_entry.key, v_config_entry.value_json);
  END LOOP;
  
  -- 2. Buscar configuración del cliente
  SELECT is_enabled, config_json INTO v_client_config
  FROM client_agent_configs
  WHERE client_id = p_client_id
    AND agent_type = p_agent_type
    AND holding_id = p_holding_id;
  
  -- 3. Si el cliente tiene configuración y está deshabilitado, retornar NULL
  IF FOUND AND NOT v_client_config.is_enabled THEN
    RETURN NULL;
  END IF;
  
  -- 4. Si el cliente tiene configuración, hacer merge (cliente override global)
  IF FOUND THEN
    RETURN v_global_config || v_client_config.config_json;
  END IF;
  
  -- 5. Si no hay configuración del cliente, retornar global
  RETURN v_global_config;
END;
$function$;

COMMENT ON FUNCTION public."get_effective_client_agent_config"(p_agent_id uuid, p_client_id uuid, p_agent_type text, p_holding_id uuid) IS 'Obtiene la configuración efectiva para un cliente. Retorna NULL si está deshabilitado, merge de global + cliente si existe config personalizada, o solo global si no hay config del cliente.';
