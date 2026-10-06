import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unificación recurrente de facturas desde Razón social 360 (05-10-2026, decisiones de Domi; `docs/v2-rediseno/spec-unificacion-recurrente.md`).
 * Crea `invoice_consolidation_rules` (entity `contratos/invoice-consolidation-rule.entity.ts`): una regla por razón social con los
 * contratos que se facturan en un solo documento cada mes y su contrato principal. Revisado contra producción: ningún objeto existente
 * guarda una regla entre contratos (`contract_billing_splits` reparte un contrato entre compañías; `contracts.group_invoices_by_period`
 * agrupa dentro de un contrato). RLS activada aquí; la policy es el asset `rls/holding_access_invoice_consolidation_rules.sql`.
 * Generada con `migration:generate` contra QA y recortada a este cambio (sin la deriva conocida).
 */
export class CreateInvoiceConsolidationRules1791800000000 implements MigrationInterface {
	name = 'CreateInvoiceConsolidationRules1791800000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE TABLE "invoice_consolidation_rules" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "holding_id" uuid NOT NULL, "client_entity_id" uuid NOT NULL, "main_contract_id" uuid NOT NULL, "contract_ids" uuid array NOT NULL, "status" text NOT NULL DEFAULT 'active', "created_by" uuid, "updated_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "invoice_consolidation_rules_holding_id_client_entity_id_key" UNIQUE ("holding_id", "client_entity_id"), CONSTRAINT "invoice_consolidation_rules_status_check" CHECK ("status" = ANY (ARRAY['active'::text, 'paused'::text])), CONSTRAINT "invoice_consolidation_rules_contract_ids_check" CHECK (cardinality("contract_ids") >= 2), CONSTRAINT "invoice_consolidation_rules_pkey" PRIMARY KEY ("id")); COMMENT ON COLUMN "invoice_consolidation_rules"."client_entity_id" IS 'Razón social receptora de las facturas unificadas'; COMMENT ON COLUMN "invoice_consolidation_rules"."main_contract_id" IS 'Contrato principal: la unificada se emite en la fecha de su factura del mes y lleva su encabezado'; COMMENT ON COLUMN "invoice_consolidation_rules"."contract_ids" IS 'Contratos que se unifican (incluye al principal; 2 o más)'; COMMENT ON COLUMN "invoice_consolidation_rules"."status" IS 'active o paused (la regla se pausa, nunca se borra)'`
		);
		await queryRunner.query(
			`CREATE INDEX "idx_invoice_consolidation_rules_holding_status" ON "invoice_consolidation_rules" ("holding_id", "status") `
		);
		await queryRunner.query(
			`COMMENT ON TABLE "invoice_consolidation_rules" IS 'Unificación recurrente de facturas de una razón social: contratos que se facturan en un solo documento cada mes y su contrato principal'`
		);
		await queryRunner.query(
			`ALTER TABLE "invoice_consolidation_rules" ADD CONSTRAINT "invoice_consolidation_rules_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "invoice_consolidation_rules" ADD CONSTRAINT "invoice_consolidation_rules_client_entity_id_fkey" FOREIGN KEY ("client_entity_id") REFERENCES "client_entities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "invoice_consolidation_rules" ADD CONSTRAINT "invoice_consolidation_rules_main_contract_id_fkey" FOREIGN KEY ("main_contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "invoice_consolidation_rules" ADD CONSTRAINT "invoice_consolidation_rules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "invoice_consolidation_rules" ADD CONSTRAINT "invoice_consolidation_rules_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "invoice_consolidation_rules" ENABLE ROW LEVEL SECURITY`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP POLICY IF EXISTS "holding_access_invoice_consolidation_rules" ON "invoice_consolidation_rules"`);
		await queryRunner.query(`DROP TABLE "invoice_consolidation_rules"`);
	}
}
