import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M8 · Configuración v2 (D13): documentos legales de la Compañía 360 con **subida real** por URL firmada de la API.
 *
 * `company_legal_documents` sirve casi tal cual (holding, compañía, nombre, tipo, fecha), pero solo guardaba `file_url` (1 fila en
 * producción, sin archivo). En vez de una tabla nueva (duplicaría el modelo) se agregan columnas, **todas nullable** (aditivo; el front
 * actual sigue escribiendo `file_url`):
 * - `storage_bucket`, `storage_path`: objeto en Storage (`<holding_id>/<company_id>/legal/<document_id>/<archivo>`); NULL = fila antigua.
 * - `file_name`, `mime_type`, `file_size`: metadatos del archivo subido.
 * - `uploaded_by` (FK `users`, `ON DELETE SET NULL`): quién lo subió.
 * Y el bucket **privado** `company-files` (20 MB; PDF, imágenes, Word, Excel), mismo patrón que `client-files`
 * (`1790272076545-CreateClientActivityNotesAndDocumentStorage`): ningún navegador accede directo; la API firma subida y descarga.
 *
 * Entity: `entities/clientes/company-legal-document.entity.ts`. **NO APLICADA** al 02-10.
 */
export class CompanyLegalDocumentsStorage1790790000000 implements MigrationInterface {
	name = 'CompanyLegalDocumentsStorage1790790000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "company_legal_documents" ADD "storage_bucket" text`);
		await queryRunner.query(`ALTER TABLE "company_legal_documents" ADD "storage_path" text`);
		await queryRunner.query(`ALTER TABLE "company_legal_documents" ADD "file_name" text`);
		await queryRunner.query(`ALTER TABLE "company_legal_documents" ADD "mime_type" text`);
		await queryRunner.query(`ALTER TABLE "company_legal_documents" ADD "file_size" bigint`);
		await queryRunner.query(`ALTER TABLE "company_legal_documents" ADD "uploaded_by" uuid`);
		await queryRunner.query(
			`COMMENT ON COLUMN "company_legal_documents"."storage_bucket" IS 'Bucket de Storage (privado) del archivo; NULL en documentos antiguos con file_url'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "company_legal_documents"."storage_path" IS 'Ruta del objeto: <holding_id>/<company_id>/legal/<id>/<archivo>'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "company_legal_documents"."uploaded_by" IS 'users.id de quien lo subió'`);
		await queryRunner.query(
			`ALTER TABLE "company_legal_documents" ADD CONSTRAINT "company_legal_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);

		await queryRunner.query(
			`INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
			VALUES ('company-files', 'company-files', false, 20971520, ARRAY[
				'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
				'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
			])
			ON CONFLICT (id) DO NOTHING`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// El bucket no se borra: puede tener archivos (Storage no permite borrar un bucket con objetos).
		await queryRunner.query(`ALTER TABLE "company_legal_documents" DROP CONSTRAINT IF EXISTS "company_legal_documents_uploaded_by_fkey"`);
		for (const column of ['uploaded_by', 'file_size', 'mime_type', 'file_name', 'storage_path', 'storage_bucket']) {
			await queryRunner.query(`ALTER TABLE "company_legal_documents" DROP COLUMN IF EXISTS "${column}"`);
		}
	}
}
