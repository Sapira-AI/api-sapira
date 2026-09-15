import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retira tres objetos de `public` con prueba estructural de que están muertos.
 *
 * **`invoice_trigger_debug_logs`** — su propio comentario de tabla dice «Tabla temporal para
 * debugging de triggers de facturas. ELIMINAR después del debugging». Verificado en producción el
 * 2026-09-14: 0 filas y **0 inserciones** en los 496 días de estadísticas acumuladas
 * (`n_tup_ins = 0` desde `stats_reset` = 2025-05-06), cero FKs entrantes, sin policies, sin entity
 * viva —es un `.espejo.ts`, fuera del glob de runtime— y sin una sola referencia en el código de
 * `api-sapira` ni de `front-sapira-vite`. Tiene scans registrados (93 secuenciales, 138 por índice),
 * pero sobre una tabla que nunca recibió una fila: leen 0 y seguirán leyendo 0. Al borrarla, lo que
 * hoy devuelve vacío en silencio pasará a fallar con un error nombrado, que es lo que queremos si
 * resulta que algo la consultaba.
 *
 * **`debug_invoice_trigger()`** — único objeto de las 315 funciones de `public` que menciona esa
 * tabla; hace `INSERT` en ella en sus dos ramas. **No está atada a ningún trigger**: las dos tablas
 * de staging de Odoo tienen un solo trigger cada una, el de `updated_at`. Va antes del `DROP TABLE`
 * porque depende de ella.
 *
 * **`cleanup_duplicate_pending_records(integer)`** — no-op estructural. Borra de `odoo_partners_stg`
 * las filas con `processing_status = 'pending'`, pero el CHECK de esa tabla solo admite
 * `create | update | processed | error`, así que ese valor no puede existir; verificado en
 * producción: **0 filas** con él. No puede borrar nada y nunca pudo. Mantenerla es un nombre que
 * promete algo que no hace, más superficie de invocación. Su hermana `cleanup_old_processed_records`
 * **sí se usa** —el front la llama por `supabase.rpc()` desde `OdooIntegrationClientes.tsx`— y no se
 * toca. La otra hermana, `cleanup_duplicate_partners_by_vat`, sí borra de verdad y espera su propia
 * ventana de observación tras el REVOKE de `grants/010-cleanup-functions-execute.sql`.
 *
 * Pre-check hecho antes de escribir esta migración: `SELECT jobid, jobname, command FROM cron.job`
 * no devuelve ningún job que mencione los tres nombres (los 4 jobs activos son de facturas vencidas,
 * sync de Salesforce y renovaciones).
 *
 * `DROP TABLE` sin `CASCADE` a propósito: si apareciera una dependencia que no vimos, queremos que
 * falle en vez de silenciarla.
 *
 * El `down()` es honesto, que es raro en un borrado: la tabla tiene 0 filas, así que recrearla la
 * deja exactamente como estaba. Las dos funciones se restauran con su cuerpo verbatim.
 */
export class RetiraObjetosDebugMuertos1789040000000 implements MigrationInterface {
	name = 'RetiraObjetosDebugMuertos1789040000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.debug_invoice_trigger()`);
		await queryRunner.query(`DROP TABLE public.invoice_trigger_debug_logs`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.cleanup_duplicate_pending_records(integer)`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`
			CREATE TABLE public.invoice_trigger_debug_logs (
				id uuid NOT NULL DEFAULT gen_random_uuid(),
				trigger_name text NOT NULL,
				operation text NOT NULL,
				holding_id uuid,
				odoo_id text,
				raw_data_sample jsonb,
				processing_status text,
				integration_notes text,
				error_message text,
				created_at timestamp with time zone DEFAULT now(),
				CONSTRAINT invoice_trigger_debug_logs_pkey PRIMARY KEY (id)
			)
		`);
		await queryRunner.query(
			`COMMENT ON TABLE public.invoice_trigger_debug_logs IS 'Tabla temporal para debugging de triggers de facturas. ELIMINAR después del debugging.'`
		);

		await queryRunner.query(`
			CREATE OR REPLACE FUNCTION public.debug_invoice_trigger()
			 RETURNS trigger
			 LANGUAGE plpgsql
			AS $function$
			BEGIN
				INSERT INTO invoice_trigger_debug_logs (
					trigger_name, operation, holding_id, odoo_id, raw_data_sample,
					processing_status, integration_notes, error_message
				) VALUES (
					'debug_invoice_trigger', TG_OP, NEW.holding_id, NEW.odoo_id,
					jsonb_build_object(
						'name', NEW.raw_data::JSONB ->> 'name',
						'id', NEW.raw_data::JSONB ->> 'id',
						'invoice_date', NEW.raw_data::JSONB ->> 'invoice_date'
					),
					COALESCE(NEW.processing_status, 'NULL'),
					COALESCE(NEW.integration_notes, 'NULL'),
					'Trigger ejecutado correctamente'
				);
				RETURN NEW;
			EXCEPTION WHEN OTHERS THEN
				INSERT INTO invoice_trigger_debug_logs (
					trigger_name, operation, holding_id, odoo_id, error_message
				) VALUES (
					'debug_invoice_trigger', TG_OP, COALESCE(NEW.holding_id, NULL),
					COALESCE(NEW.odoo_id, 'UNKNOWN'), 'ERROR: ' || SQLERRM
				);
				RETURN NEW;
			END;
			$function$
		`);

		await queryRunner.query(`
			CREATE OR REPLACE FUNCTION public.cleanup_duplicate_pending_records(batch_size integer DEFAULT 100)
			 RETURNS integer
			 LANGUAGE plpgsql
			AS $function$
			DECLARE
				deleted_count INTEGER := 0;
				current_batch INTEGER;
			BEGIN
				LOOP
					DELETE FROM odoo_partners_stg
					WHERE id IN (
						SELECT s1.id
						FROM odoo_partners_stg s1
						JOIN (
							SELECT odoo_id, MAX(created_at) as max_created
							FROM odoo_partners_stg
							WHERE processing_status = 'pending'
							GROUP BY odoo_id
							HAVING COUNT(*) > 1
						) s2 ON s1.odoo_id = s2.odoo_id AND s1.created_at < s2.max_created
						WHERE s1.processing_status = 'pending'
						LIMIT batch_size
					);
					GET DIAGNOSTICS current_batch = ROW_COUNT;
					deleted_count := deleted_count + current_batch;
					EXIT WHEN current_batch = 0;
					PERFORM pg_sleep(0.1);
				END LOOP;
				RETURN deleted_count;
			END;
			$function$
		`);
	}
}
