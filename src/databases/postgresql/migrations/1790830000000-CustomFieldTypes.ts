import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M12 · Configuración v2 ronda 3 (decisión de Domi 03-10): **campos personalizados con más tipos**.
 *
 * 1. `custom_field_definitions.options jsonb NULL`: lista `[{ value, label }]` de un campo `select` (la API la valida: obligatoria en
 *    `select`, sin valores repetidos, prohibida en el resto).
 * 2. CHECK `custom_field_definitions_field_type_check`: `text`, `number`, `select`, `boolean`, `date` (antes solo `text`/`number`).
 * 3. CHECK `custom_field_definitions_options_check`: `options` es una lista no vacía si y solo si el tipo es `select`.
 *
 * Aditiva: las 16 definiciones de producción son `text`/`number` con `options` NULL y cumplen los dos CHECK. El front actual solo crea
 * `text`/`number`. Entity `entities/base-tenancy/custom-field-definition.entity.ts` (generada desde prod): se actualiza junto con
 * `schema:snapshot` después de aplicar en producción (si se edita antes, `base-tenancy.entities.spec` falla por deriva). **NO APLICADA** al 03-10.
 */
export class CustomFieldTypes1790830000000 implements MigrationInterface {
	name = 'CustomFieldTypes1790830000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "custom_field_definitions" ADD "options" jsonb`);
		await queryRunner.query(
			`COMMENT ON COLUMN "custom_field_definitions"."options" IS 'Opciones de un campo select: [{ value, label }]. NULL en los otros tipos'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "custom_field_definitions"."field_type" IS 'Tipo de dato: text, number, select, boolean o date'`);
		await queryRunner.query(`ALTER TABLE "custom_field_definitions" DROP CONSTRAINT "custom_field_definitions_field_type_check"`);
		await queryRunner.query(
			`ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_field_type_check" CHECK (field_type = ANY (ARRAY['text'::text, 'number'::text, 'select'::text, 'boolean'::text, 'date'::text]))`
		);
		await queryRunner.query(
			`ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_options_check" CHECK ((field_type = 'select') = (options IS NOT NULL AND jsonb_typeof(options) = 'array' AND jsonb_array_length(options) > 0))`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// Solo reversible si no se crearon campos de los tipos nuevos (el CHECK viejo los rechazaría).
		await queryRunner.query(`ALTER TABLE "custom_field_definitions" DROP CONSTRAINT IF EXISTS "custom_field_definitions_options_check"`);
		await queryRunner.query(`ALTER TABLE "custom_field_definitions" DROP CONSTRAINT "custom_field_definitions_field_type_check"`);
		await queryRunner.query(
			`ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_field_type_check" CHECK (field_type = ANY (ARRAY['text'::text, 'number'::text]))`
		);
		await queryRunner.query(`ALTER TABLE "custom_field_definitions" DROP COLUMN IF EXISTS "options"`);
	}
}
