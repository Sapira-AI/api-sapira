import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M15 · Configuración v2 · usuarios (contrato §10): tabla de auditoría **`user_access_events`** (entity
 * `entities/base-tenancy/user-access-event.entity.ts`). Una fila por acción de acceso: `invited`, `invitation_resent`, `deactivated`,
 * `reactivated`, `invitation_deleted`, con quién actuó (`actor_user_id`, de la sesión) y `details` (correo, rol, estado del correo).
 *
 * - FKs: `holding_id` → `company_holdings` ON DELETE CASCADE; `user_id` y `actor_user_id` → `users` ON DELETE SET NULL (borrar a una
 *   persona nunca queda bloqueado por su auditoría; el correo queda en `details`).
 * - Índices: `(user_id, action, created_at)` para el límite de reenvíos (60 s, 5 en 24 h) y `(holding_id, created_at)` para el historial.
 * - **RLS activo sin policies**: solo la API (rol con BYPASSRLS) lee y escribe; `anon`/`authenticated` no ven nada.
 *
 * Debe aplicarse **antes** de desplegar la API con las acciones de usuarios (invitar/reenviar/acceso/eliminar escriben aquí).
 * **NO APLICADA** al 03-10.
 */
export class UserAccessEvents1790860000000 implements MigrationInterface {
	name = 'UserAccessEvents1790860000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE TABLE "user_access_events" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "holding_id" uuid NOT NULL, "user_id" uuid, "actor_user_id" uuid, "action" text NOT NULL, "details" jsonb NOT NULL DEFAULT '{}'::jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "user_access_events_action_check" CHECK ("action" = ANY (ARRAY['invited'::text, 'invitation_resent'::text, 'deactivated'::text, 'reactivated'::text, 'invitation_deleted'::text])), CONSTRAINT "user_access_events_pkey" PRIMARY KEY ("id"))`
		);
		await queryRunner.query(`CREATE INDEX "user_access_events_user_idx" ON "user_access_events" ("user_id", "action", "created_at")`);
		await queryRunner.query(`CREATE INDEX "user_access_events_holding_idx" ON "user_access_events" ("holding_id", "created_at")`);
		await queryRunner.query(
			`ALTER TABLE "user_access_events" ADD CONSTRAINT "user_access_events_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "user_access_events" ADD CONSTRAINT "user_access_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "user_access_events" ADD CONSTRAINT "user_access_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "user_access_events" IS 'Auditoría de acceso de usuarios por holding (invitar, reenviar, desactivar, reactivar, eliminar invitación). Solo la API'`
		);
		// TypeORM no modela RLS: sin policies = deny-all para anon/authenticated (el GRANT por defecto es ALL).
		await queryRunner.query(`ALTER TABLE "user_access_events" ENABLE ROW LEVEL SECURITY`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP TABLE IF EXISTS "user_access_events"`);
	}
}
