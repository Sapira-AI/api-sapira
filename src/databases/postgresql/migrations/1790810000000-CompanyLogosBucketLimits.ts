import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Configuración v2 (decisión de Domi 03-10): límites del bucket público `company-logos` (logos de holding y compañías).
 *
 * Hoy (producción, 03-10) el bucket no tiene límites (`file_size_limit` y `allowed_mime_types` en NULL) y guarda 21 objetos, todos
 * `image/png` de hasta 125 KB: los límites no dejan ningún archivo existente fuera. La API ya valida lo mismo al firmar la subida
 * (`SettingsStorageService`: 2 MB; PNG, JPG, WEBP — SVG se quitó porque un SVG público puede llevar scripts); esto lo hace cumplir
 * también en Storage. No cambia `public`.
 *
 * `down` vuelve a dejar el bucket sin límites (estado anterior). **NO APLICADA** al 03-10.
 */
export class CompanyLogosBucketLimits1790810000000 implements MigrationInterface {
	name = 'CompanyLogosBucketLimits1790810000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`UPDATE storage.buckets SET file_size_limit = 2097152, allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp']
			WHERE id = 'company-logos'`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`UPDATE storage.buckets SET file_size_limit = NULL, allowed_mime_types = NULL WHERE id = 'company-logos'`);
	}
}
