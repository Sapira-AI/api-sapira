import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * N4–N7 · Notificaciones v2, fase 2 (`docs/v2-rediseno/contrato-api-notificaciones.md` §8.9). Aditiva; el front actual no conoce las columnas.
 *
 * - **N4** `app_notifications.company_id` (nullable, FK `companies` ON DELETE SET NULL) + índice `(holding_id, company_id)`: filtro
 *   "Mis compañías" (sin compañía = la ve todo destinatario).
 * - **N5** `user_notification_preferences.company_ids uuid[]`: solo en la fila reservada `notification_type = 'my_companies'` (NULL o vacío =
 *   todas). Mismo patrón que `weekly_digest`.
 * - **N6** `notification_email_log`: registro de correos de notificación (inmediatos y resumen semanal) con UNIQUE `(user_id, dedup_key)`:
 *   deduplica (no se reenvía por la misma alerta salvo escalamiento) y hace idempotente el resumen por semana (la fila se reserva antes de
 *   enviar). Entity `entities/automatizaciones-ia/notification-email-log.entity.ts`. RLS activo **sin policies** (solo la API).
 * - **N7** `client_activity_notes.mentioned_user_ids uuid[]` y `references jsonb` (`[{ type, id }]`): menciones `@[user:<id>]` y
 *   referencias `#[<tipo>:<id>]` de la nota, derivadas de los tokens del texto por la API. Índice GIN de menciones.
 *
 * Orden: esta migración → `seed/008-notification-month-close-subscriptions.sql` → `functions/create_default_roles_for_holding.sql` → API.
 * **NO APLICADA** al 03-10.
 */
export class NotificationsPhase21790900000000 implements MigrationInterface {
	name = 'NotificationsPhase21790900000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		// N4
		await queryRunner.query(`ALTER TABLE "app_notifications" ADD "company_id" uuid`);
		await queryRunner.query(
			`ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(`CREATE INDEX "app_notifications_holding_company_idx" ON "app_notifications" ("holding_id", "company_id")`);
		await queryRunner.query(
			`COMMENT ON COLUMN "app_notifications"."company_id" IS 'Compañía de la alerta (factura, contrato). NULL = sin compañía: la ve todo destinatario'`
		);
		// N5
		await queryRunner.query(`ALTER TABLE "user_notification_preferences" ADD "company_ids" uuid array`);
		await queryRunner.query(
			`COMMENT ON COLUMN "user_notification_preferences"."company_ids" IS 'Solo en la fila my_companies: compañías que ve el usuario (NULL o vacío = todas)'`
		);
		// N6
		await queryRunner.query(
			`CREATE TABLE "notification_email_log" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "holding_id" uuid NOT NULL, "user_id" uuid NOT NULL, "kind" text NOT NULL, "dedup_key" text NOT NULL, "notification_id" uuid, "status" text NOT NULL DEFAULT 'pending', "provider_id" text, "error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "sent_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "notification_email_log_kind_check" CHECK (kind = ANY (ARRAY['alert'::text, 'digest'::text])), CONSTRAINT "notification_email_log_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])), CONSTRAINT "notification_email_log_user_dedup_key" UNIQUE ("user_id", "dedup_key"), CONSTRAINT "notification_email_log_pkey" PRIMARY KEY ("id"))`
		);
		await queryRunner.query(
			`ALTER TABLE "notification_email_log" ADD CONSTRAINT "notification_email_log_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "notification_email_log" ADD CONSTRAINT "notification_email_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "notification_email_log" ADD CONSTRAINT "notification_email_log_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "app_notifications"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "notification_email_log" IS 'Correos de notificación enviados (alerta inmediata y resumen semanal): deduplicación por usuario y clave. Solo la API'`
		);
		await queryRunner.query(`ALTER TABLE "notification_email_log" ENABLE ROW LEVEL SECURITY`);
		// N7
		await queryRunner.query(`ALTER TABLE "client_activity_notes" ADD "mentioned_user_ids" uuid array NOT NULL DEFAULT '{}'`);
		await queryRunner.query(`ALTER TABLE "client_activity_notes" ADD "references" jsonb NOT NULL DEFAULT '[]'`);
		await queryRunner.query(
			`COMMENT ON COLUMN "client_activity_notes"."mentioned_user_ids" IS 'users.id mencionados con @[user:<id>] en el texto (los deriva la API)'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "client_activity_notes"."references" IS 'Elementos del cliente referenciados con #[<tipo>:<id>]: [{ type, id }] (los deriva la API)'`
		);
		await queryRunner.query(`CREATE INDEX "client_activity_notes_mentions_idx" ON "client_activity_notes" USING gin ("mentioned_user_ids")`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP INDEX IF EXISTS "public"."client_activity_notes_mentions_idx"`);
		await queryRunner.query(`ALTER TABLE "client_activity_notes" DROP COLUMN IF EXISTS "references"`);
		await queryRunner.query(`ALTER TABLE "client_activity_notes" DROP COLUMN IF EXISTS "mentioned_user_ids"`);
		await queryRunner.query(`DROP TABLE IF EXISTS "notification_email_log"`);
		await queryRunner.query(`ALTER TABLE "user_notification_preferences" DROP COLUMN IF EXISTS "company_ids"`);
		await queryRunner.query(`DROP INDEX IF EXISTS "public"."app_notifications_holding_company_idx"`);
		await queryRunner.query(`ALTER TABLE "app_notifications" DROP CONSTRAINT IF EXISTS "app_notifications_company_id_fkey"`);
		await queryRunner.query(`ALTER TABLE "app_notifications" DROP COLUMN IF EXISTS "company_id"`);
	}
}
