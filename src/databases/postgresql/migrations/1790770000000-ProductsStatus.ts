import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M3 · Configuración v2 (spec §1.5, D9): estado del producto para **archivar** sin borrar (pestaña Productos de Precios).
 *
 * `products.status text NOT NULL DEFAULT 'active'` con CHECK `active | archived`. Aditivo: las filas existentes quedan `active` por el
 * default y el front actual (que no conoce la columna) sigue insertando sin ella. Lo escriben `POST /products/:id/archive|reactivate`.
 * Que los selectores de producto de Contratos/Cotizaciones oculten los archivados es un cambio de módulos cerrados (va con OK).
 *
 * Entity: `entities/cotizaciones-catalogo/products.entity.ts`. **NO APLICADA** al 02-10.
 */
export class ProductsStatus1790770000000 implements MigrationInterface {
	name = 'ProductsStatus1790770000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "products" ADD "status" text NOT NULL DEFAULT 'active'`);
		await queryRunner.query(
			`ALTER TABLE "products" ADD CONSTRAINT "products_status_check" CHECK (status = ANY (ARRAY['active'::text, 'archived'::text]))`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "products"."status" IS 'active | archived. Archivado = no se ofrece en altas nuevas; se conserva su historial'`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_status_check"`);
		await queryRunner.query(`ALTER TABLE "products" DROP COLUMN IF EXISTS "status"`);
	}
}
