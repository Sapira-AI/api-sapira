import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cliente 360 (rediseño, decisión Domi 24-09-2026): notas en la línea de Actividad y documentos en Storage privado.
 *
 * 1. `client_activity_notes` (entity `ClientActivityNote`): notas fechadas con autor, distintas de `clients.notes`.
 *    Solo la usa la API: RLS activo y una única policy para `service_role` (asset `rls/`); sin grants de uso para
 *    `anon`/`authenticated` más allá de los que da la base, que RLS deja sin efecto.
 * 2. Columnas nuevas en `client_documents` (todas opcionales, la app actual no se ve afectada): bucket y ruta en
 *    Storage, tamaño, tipo, quién lo subió, razón social y borrado lógico. Los documentos antiguos (bucket público
 *    `client_documents`) quedan con `storage_path` NULL.
 * 3. Bucket privado `client-files` (20 MB por archivo; PDF, imágenes, Office, CSV y texto). La API emite URLs
 *    firmadas con la clave de servicio; ningún cliente del navegador accede directo.
 *
 * El `CREATE TABLE`, el índice, las FKs y los comentarios salen tal cual de `migration:generate` (QA, 24-09). Se
 * descartó la deriva conocida que traía la generación (DROP/ADD de `fk_client_documents_holding_id` y el churn del
 * default de `client_documents.holding_id`, ver GUIA-CAMBIOS-DE-ESQUEMA → "Qué vas a ver que NO es tu cambio").
 */
export class CreateClientActivityNotesAndDocumentStorage1790272076545 implements MigrationInterface {
	name = 'CreateClientActivityNotesAndDocumentStorage1790272076545';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE TABLE "client_activity_notes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "holding_id" uuid NOT NULL, "client_id" uuid NOT NULL, "body" text NOT NULL, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "client_activity_notes_body_check" CHECK (char_length(btrim(body)) BETWEEN 1 AND 5000), CONSTRAINT "client_activity_notes_pkey" PRIMARY KEY ("id")); COMMENT ON COLUMN "client_activity_notes"."created_by" IS 'users.id de quien escribió la nota'; COMMENT ON COLUMN "client_activity_notes"."deleted_at" IS 'Borrado lógico: la nota deja de mostrarse pero se conserva'`
		);
		await queryRunner.query(`CREATE INDEX "client_activity_notes_client_idx" ON "client_activity_notes" ("client_id", "created_at") `);
		await queryRunner.query(
			`ALTER TABLE "client_activity_notes" ADD CONSTRAINT "client_activity_notes_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "client_activity_notes" ADD CONSTRAINT "client_activity_notes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "client_activity_notes" ADD CONSTRAINT "client_activity_notes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "client_activity_notes" IS 'Notas de la línea de tiempo del cliente comercial (pestaña Actividad del front nuevo). Distintas de clients.notes (nota fija).'`
		);
		// TypeORM no modela RLS: sin esto la tabla nace legible para `anon` (GRANT ALL de la base).
		await queryRunner.query(`ALTER TABLE "client_activity_notes" ENABLE ROW LEVEL SECURITY`);

		await queryRunner.query(`ALTER TABLE "client_documents" ADD "storage_bucket" text`);
		await queryRunner.query(
			`COMMENT ON COLUMN "client_documents"."storage_bucket" IS 'Bucket de Storage (privado) del archivo; NULL en documentos antiguos con URL pública'`
		);
		await queryRunner.query(`ALTER TABLE "client_documents" ADD "storage_path" text`);
		await queryRunner.query(
			`COMMENT ON COLUMN "client_documents"."storage_path" IS 'Ruta del objeto dentro del bucket: <holding_id>/<client_id>/<id>/<nombre>'`
		);
		await queryRunner.query(`ALTER TABLE "client_documents" ADD "file_size" bigint`);
		await queryRunner.query(`ALTER TABLE "client_documents" ADD "mime_type" text`);
		await queryRunner.query(`ALTER TABLE "client_documents" ADD "uploaded_by" uuid`);
		await queryRunner.query(`COMMENT ON COLUMN "client_documents"."uploaded_by" IS 'users.id de quien lo subió'`);
		await queryRunner.query(`ALTER TABLE "client_documents" ADD "client_entity_id" uuid`);
		await queryRunner.query(`COMMENT ON COLUMN "client_documents"."client_entity_id" IS 'Razón social a la que corresponde (opcional)'`);
		await queryRunner.query(`ALTER TABLE "client_documents" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`);
		await queryRunner.query(`COMMENT ON COLUMN "client_documents"."deleted_at" IS 'Borrado lógico desde el front nuevo'`);
		await queryRunner.query(
			`ALTER TABLE "client_documents" ADD CONSTRAINT "client_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "client_documents" ADD CONSTRAINT "client_documents_client_entity_id_fkey" FOREIGN KEY ("client_entity_id") REFERENCES "client_entities"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);

		await queryRunner.query(
			`INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
			VALUES ('client-files', 'client-files', false, 20971520, ARRAY[
				'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
				'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
				'application/msword', 'application/vnd.ms-excel', 'text/csv', 'text/plain'
			])
			ON CONFLICT (id) DO NOTHING`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// El bucket no se borra: puede tener archivos (Storage no permite borrar un bucket con objetos).
		await queryRunner.query(`ALTER TABLE "client_documents" DROP CONSTRAINT IF EXISTS "client_documents_client_entity_id_fkey"`);
		await queryRunner.query(`ALTER TABLE "client_documents" DROP CONSTRAINT IF EXISTS "client_documents_uploaded_by_fkey"`);
		for (const column of ['deleted_at', 'client_entity_id', 'uploaded_by', 'mime_type', 'file_size', 'storage_path', 'storage_bucket']) {
			await queryRunner.query(`ALTER TABLE "client_documents" DROP COLUMN IF EXISTS "${column}"`);
		}
		await queryRunner.query(`DROP TABLE IF EXISTS "client_activity_notes"`);
	}
}
