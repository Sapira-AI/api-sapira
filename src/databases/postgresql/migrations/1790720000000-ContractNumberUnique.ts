import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Número de contrato único por holding (auditoría S1-1 · Medios #7; decisión de Domi 01-10-2026).
 *
 * 1. Renumera los duplicados: por cada (holding, número) repetido conserva el contrato más antiguo y a los demás les asigna el
 *    siguiente correlativo libre del mismo prefijo y año en ese holding (`PREFIJO-AÑO-N`, N = máximo "normal" (< 10000) + 1, +2…).
 *    En producción son dos pares del holding 5652e95e… (CTR-2026-200 y CTR-2026-210 → CTR-2026-224 y CTR-2026-225): ninguna línea de
 *    factura lleva el número en su glosa, así que los documentos emitidos no cambian. Cada renumeración queda en `contract_lifecycle_events`.
 * 2. Crea el índice único `contracts_holding_number_unique` sobre (holding_id, contract_number) para contratos no borrados
 *    (`deleted_at IS NULL`), que es lo que v2 ya garantiza con el lock del correlativo (`contract-drafts.service.ts`).
 *
 * Idempotente: en una base sin duplicados solo crea el índice.
 */
export class ContractNumberUnique1790720000000 implements MigrationInterface {
	name = 'ContractNumberUnique1790720000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DO $renum$
DECLARE
  dup RECORD;
  v_prefix text;
  v_next int;
  v_new text;
BEGIN
  FOR dup IN
    SELECT c.id, c.holding_id, c.contract_number
    FROM contracts c
    JOIN (
      SELECT holding_id, contract_number, MIN(created_at) AS first_created
      FROM contracts WHERE deleted_at IS NULL
      GROUP BY holding_id, contract_number HAVING COUNT(*) > 1
    ) d ON d.holding_id = c.holding_id AND d.contract_number = c.contract_number
    WHERE c.deleted_at IS NULL AND c.created_at > d.first_created
    ORDER BY c.contract_number, c.created_at
  LOOP
    v_prefix := regexp_replace(dup.contract_number, '-[0-9]+$', '');
    SELECT COALESCE(MAX((regexp_match(contract_number, '-([0-9]+)$'))[1]::int) FILTER (WHERE (regexp_match(contract_number, '-([0-9]+)$'))[1]::int < 10000), 0) + 1
      INTO v_next
      FROM contracts WHERE holding_id = dup.holding_id AND contract_number LIKE v_prefix || '-%';
    v_new := v_prefix || '-' || v_next;
    UPDATE contracts SET contract_number = v_new WHERE id = dup.id;
    INSERT INTO contract_lifecycle_events (holding_id, contract_id, event_type, event_status, title, description, effective_date, metadata, created_by)
      VALUES (dup.holding_id, dup.id, 'CONTRACT_RENUMBERED', 'completed', 'Número de contrato corregido',
              'Número de contrato duplicado corregido: ' || dup.contract_number || ' → ' || v_new, CURRENT_DATE,
              jsonb_build_object('before', dup.contract_number, 'after', v_new, 'reason', 'S1-1 unique por holding (migración 1790720000000)'),
              '00000000-0000-0000-0000-000000000000');
  END LOOP;
END
$renum$`);
		await queryRunner.query(
			`CREATE UNIQUE INDEX IF NOT EXISTS "contracts_holding_number_unique" ON "contracts" ("holding_id", "contract_number") WHERE "deleted_at" IS NULL`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// Los números renumerados no se devuelven (volverían a chocar); solo se quita el índice.
		await queryRunner.query(`DROP INDEX IF EXISTS "contracts_holding_number_unique"`);
	}
}
