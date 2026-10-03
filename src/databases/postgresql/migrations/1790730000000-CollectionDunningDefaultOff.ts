import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recordatorios de cobranza apagados por defecto (Facturación v2, decisión de Domi 02-10-2026; `spec-facturacion-v2.md` §11 #5).
 *
 * `invoice_collection_settings.dunning_enabled` nacía en `true`: un holding que guardara por primera vez su configuración de cobranza
 * sin tocar ese campo quedaba con recordatorios automáticos encendidos. Ahora el default es `false`: encenderlos es una decisión
 * explícita del holding. No toca filas existentes (en producción hay una sola, del holding demo, ya en `false`).
 */
export class CollectionDunningDefaultOff1790730000000 implements MigrationInterface {
	name = 'CollectionDunningDefaultOff1790730000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "invoice_collection_settings" ALTER COLUMN "dunning_enabled" SET DEFAULT false`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "invoice_collection_settings" ALTER COLUMN "dunning_enabled" SET DEFAULT true`);
	}
}
