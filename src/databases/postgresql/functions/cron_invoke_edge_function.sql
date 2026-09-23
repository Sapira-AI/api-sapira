-- Llama una edge function desde un cron job, sin que el token quede escrito en el job.
--
-- Por qué existe: `check-overdue-invoices-daily` y `salesforce-daily-sync` tenían la service role
-- key y la URL del proyecto embebidas en `cron.job.command`. Eso impedía versionar los jobs (el
-- comando es un secreto) y obligaba a editar el job para rotar la clave. Ahora el comando es
-- `SELECT public.cron_invoke_edge_function('<funcion>', '<metodo>');` —igual en QA y en prod— y lo
-- que cambia por entorno vive en Vault:
--
--   edge_functions_base_url     https://<ref>.supabase.co/functions/v1
--   edge_functions_service_key  service role key
--
-- Los secretos se crean una vez por entorno y NO están en el repo (ver GUIA-CAMBIOS-DE-ESQUEMA.md →
-- "Sincronizar cambios a QA y producción"). Rotar la clave es actualizar el secreto; los jobs no se tocan.
--
-- `INTO STRICT`: si falta un secreto, esto levanta `no_data_found` y el job falla ruidoso, en vez de
-- hacer un POST a "/funcion" sin host y quedar en silencio.
-- `SECURITY DEFINER` + `search_path = ''`: lo invoca pg_cron y lee `vault.decrypted_secrets`, así que
-- todo va calificado con su esquema.

CREATE OR REPLACE FUNCTION public.cron_invoke_edge_function(p_function text, p_method text DEFAULT 'POST'::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
	v_url text;
	v_key text;
	v_request_id bigint;
BEGIN
	SELECT decrypted_secret INTO STRICT v_url FROM vault.decrypted_secrets WHERE name = 'edge_functions_base_url';
	SELECT decrypted_secret INTO STRICT v_key FROM vault.decrypted_secrets WHERE name = 'edge_functions_service_key';

	-- Solo la cabecera Authorization, como los jobs originales: pasar `headers` reemplaza el
	-- Content-Type por defecto de pg_net, y así queda idéntico a lo que ya corría.
	IF upper(p_method) = 'GET' THEN
		SELECT net.http_get(
			url => v_url || '/' || p_function,
			headers => jsonb_build_object('Authorization', 'Bearer ' || v_key),
			timeout_milliseconds => 3000
		) INTO v_request_id;
	ELSE
		SELECT net.http_post(
			url => v_url || '/' || p_function,
			headers => jsonb_build_object('Authorization', 'Bearer ' || v_key),
			timeout_milliseconds => 3000
		) INTO v_request_id;
	END IF;

	RETURN v_request_id;
END;
$function$
