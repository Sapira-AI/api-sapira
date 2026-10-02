import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M9 · Configuración v2 (D7): marca de **rol por defecto** en vez de comparar nombres en código.
 *
 * `roles.is_default boolean NOT NULL DEFAULT false` + backfill: `true` para los 10 roles que crea
 * `create_default_roles_for_holding` (Administrador, Invitado, Ventas, Operaciones, Revenue Ops, BI, Facturación y Cobranza, Finanzas,
 * Admin de Negocio, Admin Técnico). En producción (02-10) existen los 10 en cada uno de los 7 holdings y no hay roles propios.
 * Los roles por defecto no se editan ni se eliminan desde Configuración v2; los propios sí.
 *
 * Orden: esta migración **antes** de re-aplicar `functions/create_default_roles_for_holding.sql` (que ahora inserta `is_default = true`).
 * Aditivo: el front actual no conoce la columna; un rol que cree queda `false` (propio), que es lo correcto.
 *
 * Entity: `entities/base-tenancy/role.entity.ts`. **NO APLICADA** al 02-10.
 */
const DEFAULT_ROLE_NAMES = [
	'Administrador',
	'Invitado',
	'Ventas',
	'Operaciones',
	'Revenue Ops',
	'BI',
	'Facturación y Cobranza',
	'Finanzas',
	'Admin de Negocio',
	'Admin Técnico',
] as const;

export class RolesIsDefault1790800000000 implements MigrationInterface {
	name = 'RolesIsDefault1790800000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "roles" ADD "is_default" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(
			`COMMENT ON COLUMN "roles"."is_default" IS 'Rol creado por create_default_roles_for_holding: no se edita ni se elimina desde Configuración (D7)'`
		);
		await queryRunner.query(`UPDATE "roles" SET "is_default" = true WHERE "holding_id" IS NOT NULL AND "name" = ANY($1::text[])`, [
			[...DEFAULT_ROLE_NAMES],
		]);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN IF EXISTS "is_default"`);
	}
}
