import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Mi perfil (contrato `docs/v2-rediseno/contrato-api-mi-perfil.md` §6). Aditiva:
 *
 * - `users.avatar_preset` (id de la lista fija `preset-01…preset-12`, la valida la API) y `users.avatar_path` (ruta de la foto en el bucket
 *   `user-avatars`), ambas nullable, con `users_avatar_one_kind_check` (nunca las dos). Ambas NULL = iniciales. No había ninguna columna de
 *   avatar; `users.name` sigue siendo el nombre (sin columna nueva). Entity: `entities/base-tenancy/user.entity.ts`.
 * - `user_access_events.holding_id` pasa a nullable: los eventos de la cuenta (`password_changed`, `sessions_revoked`) no son de un
 *   holding. El CHECK de `action` suma esas dos acciones. Entity: `entities/base-tenancy/user-access-event.entity.ts`. Requiere M15
 *   (`1790860000000-UserAccessEvents`) aplicada antes.
 * - Bucket **público** `user-avatars` (2 MB; PNG, JPG, WEBP; sin SVG), mismo patrón que `company-logos`: la API firma la subida y guarda la
 *   ruta; la lectura es por URL pública. Sin policies en `storage.objects` (nadie lista; las subidas firmadas no pasan por RLS).
 *
 * Debe aplicarse **antes** de desplegar la API con `/me/*`. `down`: deshace columnas y CHECK; el bucket no se borra (puede tener archivos)
 * y el CHECK viejo y el NOT NULL de `holding_id` fallan si ya hay eventos de la cuenta (borrarlos antes, a mano y con OK). **NO APLICADA**
 * al 03-10.
 */
export class UserProfileAvatarAndAccountEvents1791050000000 implements MigrationInterface {
	name = 'UserProfileAvatarAndAccountEvents1791050000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "users" ADD "avatar_preset" text`);
		await queryRunner.query(
			`COMMENT ON COLUMN "users"."avatar_preset" IS 'Avatar elegido de la lista fija de Mi perfil (preset-01…preset-12); NULL = iniciales o foto'`
		);
		await queryRunner.query(`ALTER TABLE "users" ADD "avatar_path" text`);
		await queryRunner.query(
			`COMMENT ON COLUMN "users"."avatar_path" IS 'Ruta de la foto de perfil en el bucket user-avatars (users/<id>/<uuid>.<ext>)'`
		);
		await queryRunner.query(
			`ALTER TABLE "users" ADD CONSTRAINT "users_avatar_one_kind_check" CHECK (avatar_preset IS NULL OR avatar_path IS NULL)`
		);

		await queryRunner.query(`ALTER TABLE "user_access_events" ALTER COLUMN "holding_id" DROP NOT NULL`);
		await queryRunner.query(`ALTER TABLE "user_access_events" DROP CONSTRAINT "user_access_events_action_check"`);
		await queryRunner.query(
			`ALTER TABLE "user_access_events" ADD CONSTRAINT "user_access_events_action_check" CHECK ("action" = ANY (ARRAY['invited'::text, 'invitation_resent'::text, 'deactivated'::text, 'reactivated'::text, 'invitation_deleted'::text, 'password_changed'::text, 'sessions_revoked'::text]))`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "user_access_events" IS 'Auditoría de acceso de usuarios por holding (invitar, reenviar, desactivar, reactivar, eliminar invitación) y de la cuenta (cambio de contraseña, cierre de sesiones; holding_id NULL). Solo la API'`
		);

		await queryRunner.query(
			`INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
			VALUES ('user-avatars', 'user-avatars', true, 2097152, ARRAY['image/png', 'image/jpeg', 'image/webp'])
			ON CONFLICT (id) DO NOTHING`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// El bucket no se borra: puede tener archivos (Storage no permite borrar un bucket con objetos).
		await queryRunner.query(
			`COMMENT ON TABLE "user_access_events" IS 'Auditoría de acceso de usuarios por holding (invitar, reenviar, desactivar, reactivar, eliminar invitación). Solo la API'`
		);
		await queryRunner.query(`ALTER TABLE "user_access_events" DROP CONSTRAINT "user_access_events_action_check"`);
		await queryRunner.query(
			`ALTER TABLE "user_access_events" ADD CONSTRAINT "user_access_events_action_check" CHECK ("action" = ANY (ARRAY['invited'::text, 'invitation_resent'::text, 'deactivated'::text, 'reactivated'::text, 'invitation_deleted'::text]))`
		);
		await queryRunner.query(`ALTER TABLE "user_access_events" ALTER COLUMN "holding_id" SET NOT NULL`);
		await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_avatar_one_kind_check"`);
		await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "avatar_path"`);
		await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "avatar_preset"`);
	}
}
