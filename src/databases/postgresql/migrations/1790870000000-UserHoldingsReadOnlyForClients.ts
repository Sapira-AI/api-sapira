import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M16 · Configuración v2 · usuarios: **cierra el hueco de `user_holdings`**. La policy `user_holdings_policy_direct` era `FOR ALL` con
 * `USING (user_id = get_current_user_id())` y sin `WITH CHECK`: con la anon key y su sesión, cualquier usuario podía insertarse en
 * **cualquier holding** (`INSERT … (user_id = yo, holding_id = otro)` pasa el USING usado como CHECK) o reactivar su propio acceso
 * desactivado (`UPDATE … SET is_active = true`).
 *
 * 1. Se reemplaza por una policy **solo SELECT** con la misma condición (las lecturas del front actual siguen igual; además existe
 *    `user_holdings_access`, también SELECT).
 * 2. `REVOKE INSERT, UPDATE, DELETE` de `anon` y `authenticated` sobre `user_holdings` (defensa en profundidad, y el asset
 *    `grants/040-user-holdings-read-only.sql` lo mantiene si se re-aplica `grants/000`).
 *
 * Verificado el 03-10 (prod + `sapira-ai/src` + edge functions): el front actual **solo lee** `user_holdings`; quien escribe son RPC
 * SECURITY DEFINER (`invite_user_safe`, `create_user_holding_association_safe`, `create_user_holding_safe`, `delete_user_complete`,
 * `sync_user_on_login`), que corren como su dueño y no las afecta el REVOKE ni la policy; la edge `delete-user` usa service role; la
 * API usa un rol con BYPASSRLS. `users` **no se toca** aquí (ver spec §16: escrituras directas del front actual sobre `users`).
 *
 * El asset `rls/user_holdings_policy_direct.sql` describe el estado nuevo (re-aplicarlo converge). **NO APLICADA** al 03-10.
 */
export class UserHoldingsReadOnlyForClients1790870000000 implements MigrationInterface {
	name = 'UserHoldingsReadOnlyForClients1790870000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP POLICY IF EXISTS "user_holdings_policy_direct" ON "public"."user_holdings"`);
		await queryRunner.query(
			`CREATE POLICY "user_holdings_policy_direct" ON "public"."user_holdings" AS PERMISSIVE FOR SELECT TO public USING ((user_id = get_current_user_id()))`
		);
		await queryRunner.query(`REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."user_holdings" FROM anon, authenticated`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`GRANT INSERT, UPDATE, DELETE ON TABLE "public"."user_holdings" TO anon, authenticated`);
		await queryRunner.query(`DROP POLICY IF EXISTS "user_holdings_policy_direct" ON "public"."user_holdings"`);
		await queryRunner.query(
			`CREATE POLICY "user_holdings_policy_direct" ON "public"."user_holdings" AS PERMISSIVE FOR ALL TO public USING ((user_id = get_current_user_id()))`
		);
	}
}
