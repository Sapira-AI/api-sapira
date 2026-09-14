import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crea `public.sapira_quantity_imports` — tabla intermedia del canal DWH → quantities.
 *
 * El `CREATE TABLE`, los 4 índices, los 3 CHECK, la PK con nombre, los comentarios y la FK a
 * `company_holdings` salen tal cual de `migration:generate` desde la entity `SapiraQuantityImport`.
 *
 * Lo demás se agregó a mano tras revisar la migración generada, que traía **1883 líneas**: además
 * de esta tabla incluía las 925 sentencias de deriva pendiente del resto del esquema (DROP de
 * constraints, índices y CHECKs en 60 tablas). Se descartó todo eso.
 *
 * El índice único `sapira_quantity_imports_source_key` usa una expresión `COALESCE` y no es
 * declarable con `@Index`: vive en `special-index/` y lo aplica `yarn postgres:assets`.
 */
export class CreateSapiraQuantityImports1788949477104 implements MigrationInterface {
	name = 'CreateSapiraQuantityImports1788949477104';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE TABLE "sapira_quantity_imports" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "holding_id" uuid NOT NULL, "sf_id" text NOT NULL, "billing_date" date NOT NULL, "product" text NOT NULL, "period" date NOT NULL, "quantity" numeric(18,6), "unit_price" numeric(18,6), "unit_of_measure" character varying(32), "account" text, "currency" text, "gross_local_amount" numeric(18,2), "business_name" text, "entity_name" text, "tin" text, "country" text, "dwh_status" text, "sapira_contract_id" text, "sapira_contract_item_id" text, "quote_line_id" text, "opportunity_id" text, "resolved_contract_item_id" uuid, "resolved_contract_id" uuid, "resolution_source" text, "integration_status" text NOT NULL DEFAULT 'pending', "integration_reason" text, "quantity_id" uuid, "source_hash" text NOT NULL, "synced_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "integrated_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "sapira_quantity_imports_period_check" CHECK ("period" = (date_trunc('month'::text, ("period")::timestamp with time zone))::date), CONSTRAINT "sapira_quantity_imports_resolution_source_check" CHECK ("resolution_source" IS NULL OR "resolution_source" = ANY (ARRAY['sapira_ids'::text, 'salesforce_ids'::text])), CONSTRAINT "sapira_quantity_imports_status_check" CHECK ("integration_status" = ANY (ARRAY['pending'::text, 'integrated'::text, 'no_quantity_data'::text, 'unmapped'::text, 'not_variable'::text, 'currency_mismatch'::text, 'blocked'::text, 'ambiguous'::text, 'conflict'::text, 'changed_in_source'::text])), CONSTRAINT "PK_sapira_quantity_imports" PRIMARY KEY ("id")); COMMENT ON COLUMN "sapira_quantity_imports"."resolution_source" IS 'Cómo se resolvió contract_item_id: sapira_ids (IDs Sapira del DWH) o salesforce_ids (quote_line_id → contract_items.quote_item_number).'; COMMENT ON COLUMN "sapira_quantity_imports"."integration_status" IS 'pending | integrated | no_quantity_data | unmapped | not_variable | currency_mismatch | blocked | ambiguous | conflict | changed_in_source'; COMMENT ON COLUMN "sapira_quantity_imports"."quantity_id" IS 'FK a la fila de quantities creada por esta importación. Es el vínculo de trazabilidad DWH ↔ quantities.'`
		);
		await queryRunner.query(`CREATE INDEX "sapira_quantity_imports_quantity_idx" ON "sapira_quantity_imports" ("quantity_id")`);
		await queryRunner.query(`CREATE INDEX "sapira_quantity_imports_item_idx" ON "sapira_quantity_imports" ("resolved_contract_item_id")`);
		await queryRunner.query(`CREATE INDEX "sapira_quantity_imports_period_idx" ON "sapira_quantity_imports" ("period")`);
		await queryRunner.query(
			`CREATE INDEX "sapira_quantity_imports_status_idx" ON "sapira_quantity_imports" ("holding_id", "integration_status")`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "sapira_quantity_imports" IS 'Tabla intermedia del canal automático DWH → quantities. Registra cada fila de finance.sapira_base con el resultado de su mapeo (integration_status) para auditoría y reproceso sin re-consultar BigQuery.'`
		);
		await queryRunner.query(
			`ALTER TABLE "sapira_quantity_imports" ADD CONSTRAINT "sapira_quantity_imports_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		// Las dos FKs siguientes NO las genera TypeORM: `quantities` y `contract_items` solo
		// tienen espejo inerte, así que la entity no puede declararlas sin cargarlos en runtime.
		// Se crean acá a mano; cuando esos espejos se promuevan, pasan a la entity.
		await queryRunner.query(
			`ALTER TABLE "sapira_quantity_imports" ADD CONSTRAINT "sapira_quantity_imports_quantity_id_fkey" FOREIGN KEY ("quantity_id") REFERENCES "quantities"("id") ON DELETE SET NULL`
		);
		await queryRunner.query(
			`ALTER TABLE "sapira_quantity_imports" ADD CONSTRAINT "sapira_quantity_imports_contract_item_id_fkey" FOREIGN KEY ("resolved_contract_item_id") REFERENCES "contract_items"("id") ON DELETE SET NULL`
		);

		// TypeORM no modela RLS. Sin este ALTER la tabla nace con RLS apagado y las policies
		// de `rls/sapira_quantity_imports_*.sql` quedarían inertes.
		await queryRunner.query(`ALTER TABLE "sapira_quantity_imports" ENABLE ROW LEVEL SECURITY`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP TABLE IF EXISTS "sapira_quantity_imports"`);
	}
}
