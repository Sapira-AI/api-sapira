import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * N2 · Notificaciones v2 (`docs/v2-rediseno/contrato-api-notificaciones.md` §6): **`user_notification_preferences`** (entity
 * `entities/automatizaciones-ia/user-notification-preference.entity.ts`). Una fila por usuario, holding y tipo del catálogo: `in_app`
 * (default true) y `email` (default false). Sin fila = defaults. El resumen semanal es la fila reservada `notification_type = 'weekly_digest'`
 * (usa `email`): lo más simple, sin otra tabla.
 *
 * - FKs: `user_id` → `users` y `holding_id` → `company_holdings`, ON DELETE CASCADE.
 * - UNIQUE `(user_id, holding_id, notification_type)` (también sirve de índice para leer las preferencias de un usuario).
 * - **RLS activo sin policies**: solo la API (rol con BYPASSRLS) lee y escribe.
 *
 * **NO APLICADA** al 03-10.
 */
export class UserNotificationPreferences1790890000000 implements MigrationInterface {
	name = 'UserNotificationPreferences1790890000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE TABLE "user_notification_preferences" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "holding_id" uuid NOT NULL, "notification_type" text NOT NULL, "in_app" boolean NOT NULL DEFAULT true, "email" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "user_notification_preferences_user_holding_type_key" UNIQUE ("user_id", "holding_id", "notification_type"), CONSTRAINT "user_notification_preferences_pkey" PRIMARY KEY ("id"))`
		);
		await queryRunner.query(
			`ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "user_notification_preferences" IS 'Preferencias de notificación por usuario, holding y tipo (y resumen semanal). Solo la API'`
		);
		// TypeORM no modela RLS: sin policies = deny-all para anon/authenticated.
		await queryRunner.query(`ALTER TABLE "user_notification_preferences" ENABLE ROW LEVEL SECURITY`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP TABLE IF EXISTS "user_notification_preferences"`);
	}
}
