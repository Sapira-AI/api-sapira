import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * N1 · Notificaciones v2 (`docs/v2-rediseno/contrato-api-notificaciones.md` §6): **archivar por usuario**. `app_notification_recipients.archived_at`
 * (NULL = en la bandeja) + índice `(user_id, archived_at)` para la lista. Archivar no cambia la alerta para los demás; si la alerta escala,
 * la API la desarchiva. Aditivo: el front actual no conoce la columna.
 *
 * Entity: `entities/automatizaciones-ia/app-notification-recipient.entity.ts`. Debe aplicarse antes de desplegar la API de Notificaciones v2.
 * **NO APLICADA** al 03-10.
 */
export class NotificationRecipientsArchivedAt1790880000000 implements MigrationInterface {
	name = 'NotificationRecipientsArchivedAt1790880000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "app_notification_recipients" ADD "archived_at" TIMESTAMP WITH TIME ZONE`);
		await queryRunner.query(
			`COMMENT ON COLUMN "app_notification_recipients"."archived_at" IS 'Archivada por este usuario (no cambia la alerta para los demás)'`
		);
		await queryRunner.query(
			`CREATE INDEX "app_notification_recipients_user_archived_idx" ON "app_notification_recipients" ("user_id", "archived_at")`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP INDEX IF EXISTS "public"."app_notification_recipients_user_archived_idx"`);
		await queryRunner.query(`ALTER TABLE "app_notification_recipients" DROP COLUMN IF EXISTS "archived_at"`);
	}
}
