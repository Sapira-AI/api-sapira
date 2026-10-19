import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Integración con Kame (ERP contable): registrar en Kame las facturas emitidas en Sapira y los asientos de devengo de los meses
 * cerrados (documentación en `front-sapira/docs/integracion-kame/README.md`). Crea, siguiendo sus entities (`entities/integraciones/kame/`):
 * - `kame_connections`: credencial de Kame por compañía y ambiente (pruebas / producción), con el secret cifrado.
 * - `kame_company_settings`: ambiente activo e interruptores por compañía (todo nace apagado y en simulación).
 * - `erp_exports`: cola e historial de envíos; sus índices únicos parciales son la idempotencia (una factura o un mes por ambiente).
 * Y suma `kame` al CHECK de `holding_integration_settings` (el interruptor del envío automático por holding).
 *
 * Las tres tablas las usa solo la API: RLS activo **sin policies** (como `integration_record_discards`). Sin grants al Data API.
 * Escrita a mano (sin `migration:generate`) siguiendo las entities.
 *
 * ⚠️ Orden de despliegue: correr esta migración ANTES del deploy de api-sapira que trae el módulo `kame`.
 */
export class KameIntegration1792200000000 implements MigrationInterface {
	name = 'KameIntegration1792200000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE TABLE "kame_connections" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "holding_id" uuid NOT NULL, "company_id" uuid NOT NULL, "environment" text NOT NULL, "client_id" text NOT NULL, "client_secret_encrypted" text NOT NULL, "user_email" text NOT NULL, "kame_company_rut" text NOT NULL, "business_unit" text, "branch" text, "tested_at" TIMESTAMP WITH TIME ZONE, "test_error" text, "updated_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "kame_connections_company_environment_key" UNIQUE ("company_id", "environment"), CONSTRAINT "kame_connections_environment_check" CHECK (environment = ANY (ARRAY['pruebas'::text, 'produccion'::text])), CONSTRAINT "kame_connections_pkey" PRIMARY KEY ("id"))`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "kame_connections" IS 'Credencial de Kame de una compañía por ambiente (pruebas o producción). Solo la API'; COMMENT ON COLUMN "kame_connections"."environment" IS 'pruebas (empresa de pruebas de Kame) o produccion (la empresa real)'; COMMENT ON COLUMN "kame_connections"."client_id" IS 'Client ID de la API de Kame (datos de empresa en Kame)'; COMMENT ON COLUMN "kame_connections"."client_secret_encrypted" IS 'Client secret cifrado con EncryptionService (iv:hex). Nunca se devuelve al front'; COMMENT ON COLUMN "kame_connections"."user_email" IS 'Correo de un usuario de la empresa en Kame: va en el campo Usuario de cada envío'; COMMENT ON COLUMN "kame_connections"."kame_company_rut" IS 'RUT de la empresa en Kame (sin puntos, con guion): resguardo contra enviar a otra empresa'; COMMENT ON COLUMN "kame_connections"."business_unit" IS 'Unidad de negocio de Kame (centro de costo) para las líneas de venta y los asientos'; COMMENT ON COLUMN "kame_connections"."branch" IS 'Sucursal de Kame; vacía = casa matriz'; COMMENT ON COLUMN "kame_connections"."tested_at" IS 'Última prueba de conexión exitosa'; COMMENT ON COLUMN "kame_connections"."test_error" IS 'Error de la última prueba de conexión (null si salió bien)'; COMMENT ON COLUMN "kame_connections"."updated_by" IS 'Usuario (public.users.id) que la cambió por última vez'`
		);
		await queryRunner.query(
			`ALTER TABLE "kame_connections" ADD CONSTRAINT "kame_connections_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "kame_connections" ADD CONSTRAINT "kame_connections_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "kame_connections" ENABLE ROW LEVEL SECURITY`);

		await queryRunner.query(
			`CREATE TABLE "kame_company_settings" ("company_id" uuid NOT NULL, "holding_id" uuid NOT NULL, "active_environment" text NOT NULL DEFAULT 'pruebas', "enabled" boolean NOT NULL DEFAULT false, "send_invoices" boolean NOT NULL DEFAULT false, "send_journal" boolean NOT NULL DEFAULT false, "dry_run" boolean NOT NULL DEFAULT true, "invoices_from" date, "journal_from" date, "updated_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "kame_company_settings_environment_check" CHECK (active_environment = ANY (ARRAY['pruebas'::text, 'produccion'::text])), CONSTRAINT "kame_company_settings_pkey" PRIMARY KEY ("company_id"))`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "kame_company_settings" IS 'Uso de Kame por compañía: ambiente activo e interruptores de envío. Solo la API'; COMMENT ON COLUMN "kame_company_settings"."active_environment" IS 'Ambiente al que se envía: pruebas o produccion'; COMMENT ON COLUMN "kame_company_settings"."enabled" IS 'Conexión de la compañía activa: apagada no se encola ni se envía nada'; COMMENT ON COLUMN "kame_company_settings"."send_invoices" IS 'Registrar en Kame las facturas emitidas en Sapira'; COMMENT ON COLUMN "kame_company_settings"."send_journal" IS 'Enviar a Kame los asientos de devengo de los meses cerrados'; COMMENT ON COLUMN "kame_company_settings"."dry_run" IS 'Simulación: arma y guarda el envío sin llamar a Kame'; COMMENT ON COLUMN "kame_company_settings"."invoices_from" IS 'Se registran las facturas emitidas desde esta fecha (null = desde que se activó)'; COMMENT ON COLUMN "kame_company_settings"."journal_from" IS 'Primer mes (día 1) cuyos asientos se envían'; COMMENT ON COLUMN "kame_company_settings"."updated_by" IS 'Usuario (public.users.id) que la cambió por última vez'`
		);
		await queryRunner.query(
			`ALTER TABLE "kame_company_settings" ADD CONSTRAINT "kame_company_settings_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "kame_company_settings" ADD CONSTRAINT "kame_company_settings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "kame_company_settings" ENABLE ROW LEVEL SECURITY`);

		await queryRunner.query(
			`CREATE TABLE "erp_exports" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "holding_id" uuid NOT NULL, "company_id" uuid NOT NULL, "system" text NOT NULL, "environment" text NOT NULL, "object" text NOT NULL, "invoice_id" uuid, "period" date, "status" text NOT NULL DEFAULT 'pending', "attempts" integer NOT NULL DEFAULT 0, "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "external_id" text, "external_folio" text, "last_error" text, "request_payload" jsonb, "response" jsonb, "sent_at" TIMESTAMP WITH TIME ZONE, "requested_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "erp_exports_system_check" CHECK (system = ANY (ARRAY['kame'::text])), CONSTRAINT "erp_exports_environment_check" CHECK (environment = ANY (ARRAY['pruebas'::text, 'produccion'::text])), CONSTRAINT "erp_exports_object_check" CHECK (object = ANY (ARRAY['invoice'::text, 'journal'::text])), CONSTRAINT "erp_exports_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'error'::text, 'simulated'::text, 'skipped'::text])), CONSTRAINT "erp_exports_target_check" CHECK ((object = 'invoice' AND invoice_id IS NOT NULL AND period IS NULL) OR (object = 'journal' AND invoice_id IS NULL AND period IS NOT NULL)), CONSTRAINT "erp_exports_pkey" PRIMARY KEY ("id"))`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "erp_exports" IS 'Cola e historial de envíos de facturas y asientos a un ERP contable (Kame). Solo la API'; COMMENT ON COLUMN "erp_exports"."system" IS 'ERP de destino: kame'; COMMENT ON COLUMN "erp_exports"."environment" IS 'Ambiente del ERP al que se envió: pruebas o produccion'; COMMENT ON COLUMN "erp_exports"."object" IS 'invoice (factura emitida) o journal (asientos de devengo de un mes)'; COMMENT ON COLUMN "erp_exports"."invoice_id" IS 'Factura enviada (object = invoice)'; COMMENT ON COLUMN "erp_exports"."period" IS 'Mes de los asientos, día 1 (object = journal)'; COMMENT ON COLUMN "erp_exports"."status" IS 'pending, sending, sent, error, simulated (dry run) o skipped'; COMMENT ON COLUMN "erp_exports"."attempts" IS 'Intentos de envío hechos'; COMMENT ON COLUMN "erp_exports"."next_attempt_at" IS 'Cuándo puede volver a intentarse (espera creciente tras un error)'; COMMENT ON COLUMN "erp_exports"."external_id" IS 'Id del registro en el ERP (IdVenta / comprobante)'; COMMENT ON COLUMN "erp_exports"."external_folio" IS 'Folio del registro en el ERP'; COMMENT ON COLUMN "erp_exports"."last_error" IS 'Último error (traducido para el usuario)'; COMMENT ON COLUMN "erp_exports"."request_payload" IS 'Cuerpo enviado (o que se enviaría, en simulación)'; COMMENT ON COLUMN "erp_exports"."response" IS 'Respuesta del ERP'; COMMENT ON COLUMN "erp_exports"."sent_at" IS 'Cuándo quedó registrado en el ERP'; COMMENT ON COLUMN "erp_exports"."requested_by" IS 'Usuario que lo envió a mano (null = job)'`
		);
		await queryRunner.query(
			`CREATE UNIQUE INDEX "erp_exports_invoice_key" ON "erp_exports" ("system", "environment", "invoice_id") WHERE (object = 'invoice'::text)`
		);
		await queryRunner.query(
			`CREATE UNIQUE INDEX "erp_exports_journal_key" ON "erp_exports" ("system", "environment", "company_id", "period") WHERE (object = 'journal'::text)`
		);
		await queryRunner.query(`CREATE INDEX "idx_erp_exports_due" ON "erp_exports" ("status", "next_attempt_at")`);
		await queryRunner.query(`CREATE INDEX "idx_erp_exports_holding" ON "erp_exports" ("holding_id", "created_at")`);
		await queryRunner.query(
			`ALTER TABLE "erp_exports" ADD CONSTRAINT "erp_exports_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "erp_exports" ADD CONSTRAINT "erp_exports_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "erp_exports" ADD CONSTRAINT "erp_exports_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "erp_exports" ENABLE ROW LEVEL SECURITY`);

		await queryRunner.query(`ALTER TABLE "holding_integration_settings" DROP CONSTRAINT "holding_integration_settings_integration_check"`);
		await queryRunner.query(
			`ALTER TABLE "holding_integration_settings" ADD CONSTRAINT "holding_integration_settings_integration_check" CHECK (integration IN ('odoo', 'salesforce', 'bigquery', 'stripe', 'kame'))`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DELETE FROM "holding_integration_settings" WHERE integration = 'kame'`);
		await queryRunner.query(`ALTER TABLE "holding_integration_settings" DROP CONSTRAINT "holding_integration_settings_integration_check"`);
		await queryRunner.query(
			`ALTER TABLE "holding_integration_settings" ADD CONSTRAINT "holding_integration_settings_integration_check" CHECK (integration IN ('odoo', 'salesforce', 'bigquery', 'stripe'))`
		);
		await queryRunner.query(`DROP TABLE "erp_exports"`);
		await queryRunner.query(`DROP TABLE "kame_company_settings"`);
		await queryRunner.query(`DROP TABLE "kame_connections"`);
	}
}
