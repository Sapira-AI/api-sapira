import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Comuna de la razón social, separada de su dirección legal.
 *
 * El DTE chileno lleva el domicilio del receptor en campos distintos: `DirRecep` (calle y número, hasta 70
 * caracteres) y `CmnaRecep` (comuna, hasta 20). Hasta ahora la comuna iba escrita dentro de
 * `legal_address` ("Av. Apoquindo 4501, Las Condes") y no había de dónde sacar `CmnaRecep`. El largo se valida
 * en la API (`CreateClientEntityDto` / `UpdateClientEntityDto`), no con un CHECK: las razones sociales de otros
 * países no la usan. NULL = sin comuna; el relleno de las existentes queda para otra tarea.
 *
 * ⚠️ Orden de despliegue: correr esta migración ANTES de desplegar el código que declara la columna en
 * `ClientEntity`. Al revés, TypeORM seleccionaría una columna inexistente en cada lectura de la tabla.
 */
export class AddClientEntityCommune1791900000000 implements MigrationInterface {
	name = 'AddClientEntityCommune1791900000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "public"."client_entities" ADD COLUMN IF NOT EXISTS "commune" text`);
		await queryRunner.query(
			`COMMENT ON COLUMN "public"."client_entities"."commune" IS 'Comuna de la dirección legal (CmnaRecep del DTE chileno, hasta 20 caracteres). NULL = sin comuna'`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "public"."client_entities" DROP COLUMN IF EXISTS "commune"`);
	}
}
