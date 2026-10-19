import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Importar para actualizar" clientes (Domi 19-10): dos tablas nuevas, genéricas para el motor único de import.
 *
 * - `import_batches` (entity `entities/clientes/import-batch.entity.ts`): un lote por importación, con la entidad, la clave de búsqueda, los
 *   campos mapeados, los conteos y, si se revirtió, cuándo, quién y el resumen.
 * - `import_batch_rows` (entity `entities/clientes/import-batch-row.entity.ts`): una fila por fila de la planilla, con el registro alcanzado,
 *   el estado y los valores antes/después de cada campo cambiado (lo que permite revertir).
 *
 * Solo esquema: tablas vacías. RLS activada aquí; las policies son los assets `rls/holding_access_import_batches.sql` y
 * `rls/holding_access_import_batch_rows.sql`. ⚠️ Orden de despliegue: correr esta migración antes de desplegar el código que las usa.
 */
export class CreateImportBatches1792200000000 implements MigrationInterface {
	name = 'CreateImportBatches1792200000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE TABLE "import_batches" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "holding_id" uuid NOT NULL, "entity_type" text NOT NULL, "label" text, "key_field" text NOT NULL, "fields" jsonb NOT NULL DEFAULT '[]'::jsonb, "rows_total" integer NOT NULL DEFAULT 0, "updated_count" integer NOT NULL DEFAULT 0, "skipped_count" integer NOT NULL DEFAULT 0, "failed_count" integer NOT NULL DEFAULT 0, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "reverted_at" TIMESTAMP WITH TIME ZONE, "reverted_by" uuid, "reverted_summary" jsonb, CONSTRAINT "import_batches_entity_type_check" CHECK (entity_type = ANY (ARRAY['client'::text])), CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id"))`
		);
		await queryRunner.query(`CREATE INDEX "idx_import_batches_holding_created" ON "import_batches" ("holding_id", "created_at") `);
		await queryRunner.query(
			`COMMENT ON TABLE "import_batches" IS 'Lotes de "Importar para actualizar" (clientes; genérico para otras entidades). Solo la API escribe'`
		);
		for (const [column, comment] of [
			['entity_type', 'Entidad actualizada: client (clientes comerciales)'],
			['label', 'Nombre del lote (por defecto, el archivo subido)'],
			['key_field', 'Con qué se buscó cada fila: client_number | tax_id'],
			['fields', 'Campos mapeados en la planilla (los únicos que se actualizan)'],
			['updated_count', 'Filas que cambiaron al menos un campo'],
			['skipped_count', 'Filas sin cambios, no encontradas o ambiguas'],
			['failed_count', 'Filas con error de validación'],
			['reverted_at', 'Cuándo se revirtió el lote (NULL = vigente)'],
			['reverted_summary', 'Resumen de la reversión: { restored_rows, kept_rows, kept_fields }'],
		])
			await queryRunner.query(`COMMENT ON COLUMN "import_batches"."${column}" IS '${comment}'`);
		await queryRunner.query(
			`ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_reverted_by_fkey" FOREIGN KEY ("reverted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY`);

		await queryRunner.query(
			`CREATE TABLE "import_batch_rows" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "batch_id" uuid NOT NULL, "holding_id" uuid NOT NULL, "row" integer NOT NULL, "key_value" text NOT NULL, "entity_id" uuid, "status" text NOT NULL, "before" jsonb NOT NULL DEFAULT '{}'::jsonb, "after" jsonb NOT NULL DEFAULT '{}'::jsonb, "message" text, "reverted_fields" jsonb, "kept_fields" jsonb, CONSTRAINT "import_batch_rows_status_check" CHECK (status = ANY (ARRAY['updated'::text, 'unchanged'::text, 'not_found'::text, 'ambiguous'::text, 'failed'::text])), CONSTRAINT "import_batch_rows_pkey" PRIMARY KEY ("id"))`
		);
		await queryRunner.query(`CREATE INDEX "idx_import_batch_rows_batch" ON "import_batch_rows" ("batch_id") `);
		await queryRunner.query(
			`CREATE INDEX "idx_import_batch_rows_holding_entity" ON "import_batch_rows" ("holding_id", "entity_id") WHERE entity_id IS NOT NULL`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "import_batch_rows" IS 'Filas de un lote de "Importar para actualizar": registro, estado y valores antes/después'`
		);
		for (const [column, comment] of [
			['row', 'Fila en la planilla (la 1 son los encabezados)'],
			['key_value', 'Valor de la clave en la planilla (N° cliente o RUT)'],
			['entity_id', 'Registro encontrado (clients.id); NULL si no se encontró o fue ambiguo'],
			['status', 'updated | unchanged | not_found | ambiguous | failed'],
			['before', 'Valor anterior de cada campo cambiado'],
			['after', 'Valor nuevo de cada campo cambiado'],
			['message', 'Motivo (error de validación, ambigua, no encontrada)'],
			['reverted_fields', 'Al revertir: campos restaurados'],
			['kept_fields', 'Al revertir: campos que no se tocaron porque alguien los editó después'],
		])
			await queryRunner.query(`COMMENT ON COLUMN "import_batch_rows"."${column}" IS '${comment}'`);
		await queryRunner.query(
			`ALTER TABLE "import_batch_rows" ADD CONSTRAINT "import_batch_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "import_batch_rows" ADD CONSTRAINT "import_batch_rows_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "import_batch_rows" ENABLE ROW LEVEL SECURITY`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP POLICY IF EXISTS "holding_access_import_batch_rows" ON "import_batch_rows"`);
		await queryRunner.query(`DROP TABLE IF EXISTS "import_batch_rows"`);
		await queryRunner.query(`DROP POLICY IF EXISTS "holding_access_import_batches" ON "import_batches"`);
		await queryRunner.query(`DROP TABLE IF EXISTS "import_batches"`);
	}
}
