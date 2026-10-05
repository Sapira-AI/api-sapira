import { MigrationInterface, QueryRunner } from 'typeorm';

import { BACKUP_SCHEMA, CREATE_BACKUP_SCHEMA_SQL } from '../backups';

/**
 * Una sola fuente de consumos (05-10-2026, decisión de Domi; `docs/v2-rediseno/rebuild-devengo-comparacion.md` §9.5 D2-c y
 * `spec-pricing-v2.md` §4.5): copia TODAS las filas de `quantities` (overrides del período del front anterior y del canal del almacén de
 * datos) a `consumption_entries`, la tabla de Pricing v2 (migración `1790630000000-CreatePricingV2`; no es la staging del DWH
 * `sapira_quantity_imports`). Desde aquí la regla de devengo (`revenue_schedule_rebuild_contract_ccy` v3.8), la pestaña Consumos y la
 * sincronización del DWH leen y escriben solo `consumption_entries`; `quantities` queda de solo lectura (no se borra; sus triggers quedan sin
 * uso hasta retirarla con la tabla, `catalogo-funciones-y-triggers.md`). En producción (lectura del 05-10): **315 filas, 97 ítems, 78
 * contratos**, todas de SimpliRoute.
 *
 * Semántica de cada fila (la misma con que D2 devengaba y `sync_invoice_items_amounts_from_quantities` armaba la línea):
 * - **Período**: el de la línea de factura del ítem que empieza en ese mes (con el día de ciclo del contrato puede no ser el día 1; se prefiere
 *   la vigente y la Por Emitir); sin línea, el mes calendario. `invoice_id` = la factura vigente (no NC/ND) de esa línea, o NULL.
 * - **Cantidad**: la del override; sin cantidad, la del ítem.
 * - **Monto fijado** (`amount_override`, antes del descuento): unitario del override × cantidad cuando el unitario difiere del del ítem; solo
 *   monto (sin unitario ni cantidad) → ese monto; si no, NULL (cantidad × precio del ítem). `apply_item_discount = true` (D2 aplicaba el
 *   descuento de la línea).
 * - **Origen y fechas**: `source` = `dwh` si la fila la escribió el canal automático (`notes` empieza con "DWH sapira_base"), si no
 *   `manual`; `idempotency_key = 'quantities:<id>'` (trazabilidad y reemplazo de notificaciones viejas); `notes`, `account`,
 *   `created_at`/`updated_at` de la fila; `created_by` solo si es un usuario de `users`. Revisión 1 con su fila en
 *   `consumption_entry_revisions`. Sin etiqueta visible de "front anterior": se ven como cualquier consumo o corrección.
 *
 * **Respaldo**: `<BACKUP_SCHEMA>.consumption_entries_1791600000000` (id de `quantities` → id de la entry creada). `down()` borra solo las
 * entries creadas aquí que siguen en su revisión 1 (las corregidas después quedan en el respaldo para revisarlas a mano) y el respaldo si
 * queda vacío. Idempotente: una fila ya copiada (por `idempotency_key`) o un período con consumo ya registrado no se vuelve a insertar.
 */

const BACKUP_TABLE = `${BACKUP_SCHEMA}.consumption_entries_1791600000000`;
const DWH_NOTES_PREFIX = 'DWH sapira_base';
const ISSUED_OR_PENDING = `'Por Emitir', 'Emitida', 'Enviada', 'Pagada', 'Vencida'`;

/** Filas de `quantities` por copiar, con el período de la línea del mes y los datos del ítem. */
const SOURCE_SQL = `
	SELECT q.id AS quantity_id, q.contract_item_id, ci.contract_id, c.holding_id,
		COALESCE(l.billing_period_start, date_trunc('month', q.period)::date) AS period_start,
		COALESCE(l.billing_period_end, l.billing_period_start, (date_trunc('month', q.period) + interval '1 month' - interval '1 day')::date) AS period_end,
		GREATEST(0, COALESCE(q.quantity, ci.quantity, 0)) AS quantity,
		CASE
			WHEN q.quantity IS NOT NULL AND q.unit_price IS NOT NULL
				THEN CASE WHEN q.unit_price IS NOT DISTINCT FROM ci.unit_price THEN NULL ELSE ROUND(q.unit_price * q.quantity, 2) END
			WHEN q.quantity IS NULL AND q.unit_price IS NULL THEN q.amount
			WHEN q.quantity IS NULL AND q.unit_price IS NOT NULL
				THEN CASE WHEN q.unit_price IS NOT DISTINCT FROM ci.unit_price THEN NULL ELSE ROUND(q.unit_price * ci.quantity, 2) END
			ELSE NULL
		END AS amount_override,
		NULLIF(TRIM(q.account), '') AS account,
		CASE WHEN q.notes LIKE '${DWH_NOTES_PREFIX}%' THEN 'dwh' ELSE 'manual' END AS source,
		q.notes, l.invoice_id, q.created_at, COALESCE(q.updated_at, q.created_at) AS updated_at,
		(SELECT u.id FROM users u WHERE u.id = q.created_by) AS created_by
	FROM quantities q
	JOIN contract_items ci ON ci.id = q.contract_item_id
	JOIN contracts c ON c.id = ci.contract_id
	LEFT JOIN LATERAL (
		SELECT ii.billing_period_start, ii.billing_period_end,
			CASE WHEN i.is_active AND i.status IN (${ISSUED_OR_PENDING}) THEN i.id END AS invoice_id
		FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
		WHERE ii.contract_item_id = q.contract_item_id
			AND ii.billing_period_start IS NOT NULL
			AND date_trunc('month', ii.billing_period_start) = date_trunc('month', q.period)
			AND COALESCE(i.document_type, '') NOT IN ('NC', 'ND')
		ORDER BY (i.is_active AND i.status IN (${ISSUED_OR_PENDING})) DESC, (i.status = 'Por Emitir') DESC, ii.billing_period_start, ii.id
		LIMIT 1
	) l ON true
	WHERE q.period IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM consumption_entries e WHERE e.idempotency_key = 'quantities:' || q.id::text)`;

export class ConsumosDesdeQuantities1791600000000 implements MigrationInterface {
	name = 'ConsumosDesdeQuantities1791600000000';
	// Todo export de una migración debe ser su clase (schema-status.spec): lo que usan los tests se expone como estático.
	static readonly BACKUP_TABLE = BACKUP_TABLE;
	static readonly SOURCE_SQL = SOURCE_SQL;

	public async up(queryRunner: QueryRunner): Promise<void> {
		for (const sql of CREATE_BACKUP_SCHEMA_SQL) await queryRunner.query(sql);
		await queryRunner.query(
			`CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (
				quantity_id uuid PRIMARY KEY,
				entry_id uuid NOT NULL,
				contract_item_id uuid NOT NULL,
				period_start date NOT NULL,
				backed_up_at timestamptz NOT NULL DEFAULT now()
			)`
		);
		// Sin policies: con RLS activo, solo el dueño (la conexión de migraciones) la lee.
		await queryRunner.query(`ALTER TABLE ${BACKUP_TABLE} ENABLE ROW LEVEL SECURITY`);

		// Entries (revisión 1) + respaldo, en una sentencia. Un período que ya tiene consumo registrado no se pisa (ON CONFLICT).
		await queryRunner.query(
			`WITH src AS (${SOURCE_SQL}),
			ins AS (
				INSERT INTO consumption_entries (
					holding_id, contract_id, contract_item_id, period_start, period_end, quantity, amount_override, apply_item_discount, account,
					is_estimated, source, idempotency_key, revision, correction_reason, notes, invoice_id, created_at, updated_at, created_by, updated_by
				)
				SELECT holding_id, contract_id, contract_item_id, period_start, period_end, quantity, amount_override, true, account,
					false, source, 'quantities:' || quantity_id::text, 1, NULL, notes, invoice_id, created_at, updated_at, created_by, created_by
				FROM src
				ON CONFLICT (contract_item_id, period_start) DO NOTHING
				RETURNING id, idempotency_key, contract_item_id, period_start
			)
			INSERT INTO ${BACKUP_TABLE} (quantity_id, entry_id, contract_item_id, period_start)
			SELECT substring(idempotency_key FROM 12)::uuid, id, contract_item_id, period_start FROM ins
			ON CONFLICT (quantity_id) DO NOTHING`
		);
		// Historial append-only: la revisión 1 de cada entry copiada.
		await queryRunner.query(
			`INSERT INTO consumption_entry_revisions (holding_id, entry_id, revision, quantity, amount_override, apply_item_discount, source, reason, changed_by, changed_at)
			SELECT e.holding_id, e.id, 1, e.quantity, e.amount_override, e.apply_item_discount, e.source, NULL, e.created_by, e.updated_at
			FROM ${BACKUP_TABLE} b JOIN consumption_entries e ON e.id = b.entry_id
			WHERE NOT EXISTS (SELECT 1 FROM consumption_entry_revisions r WHERE r.entry_id = e.id AND r.revision = 1)`
		);
	}

	/** Borra solo las entries creadas aquí que siguen sin corregir (revisión 1); el resto queda en el respaldo. */
	public async down(queryRunner: QueryRunner): Promise<void> {
		const [exists] = (await queryRunner.query(`SELECT to_regclass('${BACKUP_TABLE}') IS NOT NULL AS present`)) as Array<{ present: boolean }>;

		if (!exists?.present) return;
		await queryRunner.query(
			`DELETE FROM consumption_entry_revisions r USING ${BACKUP_TABLE} b, consumption_entries e
			WHERE r.entry_id = b.entry_id AND e.id = b.entry_id AND e.revision = 1`
		);
		await queryRunner.query(
			`WITH gone AS (
				DELETE FROM consumption_entries e USING ${BACKUP_TABLE} b WHERE e.id = b.entry_id AND e.revision = 1 RETURNING e.id
			)
			DELETE FROM ${BACKUP_TABLE} b USING gone g WHERE b.entry_id = g.id`
		);
		// Respaldos de entries que ya no existen (borradas por otro camino): nada que deshacer.
		await queryRunner.query(`DELETE FROM ${BACKUP_TABLE} b WHERE NOT EXISTS (SELECT 1 FROM consumption_entries e WHERE e.id = b.entry_id)`);
		const [left] = (await queryRunner.query(`SELECT count(*)::int AS n FROM ${BACKUP_TABLE}`)) as Array<{ n: number }>;

		if (Number(left?.n ?? 0) === 0) {
			await queryRunner.query(`DROP TABLE ${BACKUP_TABLE}`);
			await queryRunner.query(
				`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = '${BACKUP_SCHEMA}'::regnamespace) THEN DROP SCHEMA ${BACKUP_SCHEMA}; END IF; END $$`
			);
		}
	}
}
