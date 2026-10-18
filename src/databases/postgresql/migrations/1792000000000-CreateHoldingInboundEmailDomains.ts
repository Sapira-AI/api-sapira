import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dominio de recepción de DTE por holding (intercambio de información SII, Fase 5; plan en
 * `front-lenosoft/app/docs/content/api-factura/proyecto/plan-certificacion-sapira.md`). Crea `holding_inbound_email_domains`
 * (entity `automatizaciones-ia/holding-inbound-email-domain.entity.ts`): un subdominio por holding con MX hacia SendGrid Inbound
 * Parse, autenticado en SendGrid para responder desde sus casillas. Tabla aparte de `holding_email_sender_settings` para que la
 * pestaña Comunicaciones existente no dependa de esta migración. RLS activada aquí; la policy es el asset
 * `rls/holding_access_holding_inbound_email_domains.sql`. Escrita a mano (sin `migration:generate`) siguiendo la entity.
 *
 * ⚠️ Orden de despliegue: correr esta migración ANTES de usar el dominio de recepción en Comunicaciones.
 */
export class CreateHoldingInboundEmailDomains1792000000000 implements MigrationInterface {
	name = 'CreateHoldingInboundEmailDomains1792000000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE TABLE "holding_inbound_email_domains" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "holding_id" uuid NOT NULL, "inbound_domain" text NOT NULL, "sendgrid_domain_id" text, "domain_status" text NOT NULL DEFAULT 'pending', "dns_records" jsonb, "mx_verified_at" TIMESTAMP WITH TIME ZONE, "domain_verified_at" TIMESTAMP WITH TIME ZONE, "inbound_parse_configured_at" TIMESTAMP WITH TIME ZONE, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "holding_inbound_email_domains_holding_id_key" UNIQUE ("holding_id"), CONSTRAINT "holding_inbound_email_domains_inbound_domain_key" UNIQUE ("inbound_domain"), CONSTRAINT "holding_inbound_email_domains_status_check" CHECK ("domain_status" = ANY (ARRAY['pending'::text, 'verified'::text])), CONSTRAINT "holding_inbound_email_domains_pkey" PRIMARY KEY ("id")); COMMENT ON COLUMN "holding_inbound_email_domains"."inbound_domain" IS 'Subdominio de recepción, en minúsculas (ej: dte.miempresa.cl)'; COMMENT ON COLUMN "holding_inbound_email_domains"."sendgrid_domain_id" IS 'ID del dominio autenticado en SendGrid (para responder desde las casillas)'; COMMENT ON COLUMN "holding_inbound_email_domains"."domain_status" IS 'pending o verified: verified cuando el MX y los CNAME de autenticación están puestos'; COMMENT ON COLUMN "holding_inbound_email_domains"."dns_records" IS 'Registros DNS a publicar: MX hacia SendGrid y los CNAME de autenticación, con su estado'; COMMENT ON COLUMN "holding_inbound_email_domains"."inbound_parse_configured_at" IS 'Cuándo se creó el Inbound Parse en SendGrid (apunta al webhook de api-factura)'`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "holding_inbound_email_domains" IS 'Dominio de recepción de DTE del holding (MX hacia SendGrid Inbound Parse)'`
		);
		await queryRunner.query(
			`ALTER TABLE "holding_inbound_email_domains" ADD CONSTRAINT "holding_inbound_email_domains_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "holding_inbound_email_domains" ADD CONSTRAINT "holding_inbound_email_domains_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "holding_inbound_email_domains" ENABLE ROW LEVEL SECURITY`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP POLICY IF EXISTS "holding_access_holding_inbound_email_domains" ON "holding_inbound_email_domains"`);
		await queryRunner.query(`DROP TABLE "holding_inbound_email_domains"`);
	}
}
