import { MigrationInterface, QueryRunner } from 'typeorm';

import { BACKUP_SCHEMA, CREATE_BACKUP_SCHEMA_SQL } from '../backups';

/**
 * Ítems variables de SimpliRoute → precio por consumo de Pricing v2 (05-10-2026, decisión de Domi; `spec-pricing-v2.md` §4.5). La marca
 * de "variable" del front nuevo es la de Pricing v2 (el ítem apunta con `contract_items.price_id` a un precio `quantity_type = 'metered'`),
 * NO `contract_items.item_type` (dato maestro configurable por holding). En producción (lectura del 05-10) SimpliRoute tiene **134 ítems
 * `item_type = 'Variable'`**, ninguno con `price_id`, y 0 precios.
 *
 * Para cada ítem variable de SimpliRoute sin precio y con unitario > 0 (**131**: quedan fuera los 3 espejos de baja con unitario negativo,
 * 2 CHURN de contratos Cancelados y 1 DOWNSELL, que no se facturan por consumo y que el motor rechaza: un precio no puede ser negativo):
 * 1. **Métrica** facturable del holding por unidad de medida del ítem (`billable_metrics`, exigida por el CHECK `prices_metered_metric_check`):
 *    vehículos, mensajes, rutas, visitas, bolsas y unidades; `aggregation = 'sum'`, `source_kind = 'dwh'` (las cantidades llegan del
 *    almacén de datos). Si el código ya existe se reutiliza.
 * 2. **Precio propio del contrato** (`owner = 'contract'`, `contract_id`, v1 `active`, `published_at`), `model = 'standard'`,
 *    `quantity_type = 'metered'`, moneda del ítem, `invoice_line_mode = 'single'` y `unit_amount` = precio **del período** (`priceLine` lo
 *    usa tal cual): unitario mensual del ítem × meses de la frecuencia (Mensual 1 … Anual 12). Con descuento en **monto fijo** (5 ítems) el
 *    unitario es el neto (`monthly_price ÷ cantidad`), porque el motor de precios omite el descuento en monto fijo: así la línea con la
 *    cantidad base sigue siendo el mensual de hoy. El descuento en porcentaje lo sigue aplicando el motor (`discount_pct` del ítem).
 * 3. `contract_items.price_id` → ese precio.
 *
 * No cambia montos: `monthly_price`, `final_price`, las facturas y el devengo quedan iguales (el rebuild sigue usando `monthly_price` como
 * plan). Lo que cambia: la pestaña Consumos los trata como "por consumo" (Agregar consumo, pendientes de informar, vista previa con el
 * motor) y las facturas que se generen en adelante para esos ítems nacen con la cantidad base `pending` hasta informar el consumo.
 *
 * **Respaldo**: `<BACKUP_SCHEMA>.contract_items_price_1791700000000` (ítem → precio creado, `price_id` anterior) y
 * `<BACKUP_SCHEMA>.billable_metrics_1791700000000` (métricas creadas). `down()` devuelve `price_id` a su valor anterior solo donde sigue
 * apuntando al precio creado, borra esos precios y las métricas creadas que ya no usa ningún precio. Idempotente: un ítem que ya tiene
 * `price_id` no se toca y una métrica existente se reutiliza.
 */

const HOLDING_ID = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6';
const ITEMS_BACKUP = `${BACKUP_SCHEMA}.contract_items_price_1791700000000`;
const METRICS_BACKUP = `${BACKUP_SCHEMA}.billable_metrics_1791700000000`;

/** Código de métrica por unidad de medida del ítem (sin tildes, minúsculas): una métrica por unidad. */
const METRIC_CODE_SQL = (alias: string) => `CASE
		WHEN lower(${alias}.unit_of_measure) LIKE 'veh%' THEN 'vehiculos'
		WHEN lower(${alias}.unit_of_measure) LIKE 'mensaje%' THEN 'mensajes'
		WHEN lower(${alias}.unit_of_measure) LIKE 'ruta%' THEN 'rutas'
		WHEN lower(${alias}.unit_of_measure) LIKE 'visita%' THEN 'visitas'
		WHEN lower(${alias}.unit_of_measure) LIKE 'bolsa%' THEN 'bolsas'
		ELSE 'unidades' END`;

/** Métricas (código, nombre, unidad en singular). */
const METRICS: Array<[string, string, string]> = [
	['vehiculos', 'Vehículos', 'vehículo'],
	['mensajes', 'Mensajes', 'mensaje'],
	['rutas', 'Rutas', 'ruta'],
	['visitas', 'Visitas', 'visita'],
	['bolsas', 'Bolsas', 'bolsa'],
	['unidades', 'Unidades', 'unidad'],
];

/** Ítems a convertir: variables de SimpliRoute, sin precio, con unitario y cantidad > 0 y producto. */
const TARGET_ITEMS_SQL = `
	SELECT ci.id AS item_id, ci.contract_id, ci.product_id, ci.product_name, COALESCE(ci.currency, c.contract_currency) AS currency,
		${METRIC_CODE_SQL('ci')} AS metric_code,
		ROUND(
			CASE WHEN ci.discount_type = 'Monto fijo' AND COALESCE(ci.discount_value, 0) > 0 AND ci.monthly_price IS NOT NULL
				THEN ci.monthly_price / ci.quantity
				ELSE ci.unit_price END
			* CASE ci.billing_frequency WHEN 'Trimestral' THEN 3 WHEN 'Semestral' THEN 6 WHEN 'Anual' THEN 12 WHEN 'Bianual' THEN 24 ELSE 1 END,
		6) AS unit_amount
	FROM contract_items ci
	JOIN contracts c ON c.id = ci.contract_id
	WHERE c.holding_id = '${HOLDING_ID}'
		AND ci.item_type = 'Variable'
		AND ci.price_id IS NULL
		AND ci.product_id IS NOT NULL
		AND COALESCE(ci.unit_price, 0) > 0
		AND COALESCE(ci.quantity, 0) > 0`;

export class PreciosMedidosSimpliRoute1791700000000 implements MigrationInterface {
	name = 'PreciosMedidosSimpliRoute1791700000000';
	// Todo export de una migración debe ser su clase (schema-status.spec): lo que usan los tests se expone como estático.
	static readonly HOLDING_ID = HOLDING_ID;
	static readonly ITEMS_BACKUP = ITEMS_BACKUP;
	static readonly METRICS_BACKUP = METRICS_BACKUP;
	static readonly TARGET_ITEMS_SQL = TARGET_ITEMS_SQL;
	static readonly METRICS = METRICS;

	public async up(queryRunner: QueryRunner): Promise<void> {
		for (const sql of CREATE_BACKUP_SCHEMA_SQL) await queryRunner.query(sql);
		await queryRunner.query(
			`CREATE TABLE IF NOT EXISTS ${METRICS_BACKUP} (metric_id uuid PRIMARY KEY, code text NOT NULL, backed_up_at timestamptz NOT NULL DEFAULT now())`
		);
		await queryRunner.query(
			`CREATE TABLE IF NOT EXISTS ${ITEMS_BACKUP} (
				item_id uuid PRIMARY KEY, old_price_id uuid, new_price_id uuid NOT NULL, backed_up_at timestamptz NOT NULL DEFAULT now()
			)`
		);
		// Sin policies: con RLS activo, solo el dueño (la conexión de migraciones) las lee.
		await queryRunner.query(`ALTER TABLE ${METRICS_BACKUP} ENABLE ROW LEVEL SECURITY`);
		await queryRunner.query(`ALTER TABLE ${ITEMS_BACKUP} ENABLE ROW LEVEL SECURITY`);
		const [holding] = (await queryRunner.query(`SELECT 1 AS present FROM company_holdings WHERE id = $1`, [HOLDING_ID])) as Array<{
			present: number;
		}>;

		if (!holding) return; // Entorno sin SimpliRoute (local vacío, QA sin el holding): nada que hacer.

		// 1 · Métricas que usan los ítems (solo las que faltan), con respaldo de las creadas.
		await queryRunner.query(
			`WITH needed AS (SELECT DISTINCT metric_code FROM (${TARGET_ITEMS_SQL}) t),
			defs AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS d(code text, name text, unit text)),
			ins AS (
				INSERT INTO billable_metrics (holding_id, code, name, description, aggregation, unit, source_kind, source_config, status)
				SELECT '${HOLDING_ID}', d.code, d.name, 'Cantidad del período que informa el almacén de datos (finance.sapira_base)', 'sum', d.unit,
					'dwh', '{"origen": "finance.sapira_base", "canal": "sincronización de cantidades"}'::jsonb, 'active'
				FROM defs d JOIN needed n ON n.metric_code = d.code
				ON CONFLICT (holding_id, code) DO NOTHING
				RETURNING id, code
			)
			INSERT INTO ${METRICS_BACKUP} (metric_id, code) SELECT id, code FROM ins ON CONFLICT (metric_id) DO NOTHING`,
			[JSON.stringify(METRICS.map(([code, name, unit]) => ({ code, name, unit })))]
		);

		// 2 + 3 · Precio propio del contrato por ítem, vínculo y respaldo, en una sentencia.
		await queryRunner.query(
			`WITH t AS (${TARGET_ITEMS_SQL}),
			src AS (
				SELECT t.*, gen_random_uuid() AS price_id, bm.id AS metric_id
				FROM t JOIN billable_metrics bm ON bm.holding_id = '${HOLDING_ID}' AND bm.code = t.metric_code
			),
			prices_ins AS (
				INSERT INTO prices (
					id, holding_id, owner, product_id, contract_id, name, currency, model, quantity_type, billable_metric_id, unit_amount,
					seat_minimum_quantity, free_units, invoice_line_mode, charge_flat_when_free, status, version, published_at, notes
				)
				SELECT price_id, '${HOLDING_ID}', 'contract', product_id, contract_id, COALESCE(product_name, 'Precio por consumo'), currency, 'standard',
					'metered', metric_id, unit_amount, 0, 0, 'single', false, 'active', 1, now(),
					'Migración 1791700000000: ítem variable del front anterior pasado a precio por consumo'
				FROM src
				RETURNING id
			),
			items_upd AS (
				UPDATE contract_items ci SET price_id = s.price_id
				FROM src s
				WHERE ci.id = s.item_id AND ci.price_id IS NULL AND EXISTS (SELECT 1 FROM prices_ins p WHERE p.id = s.price_id)
				RETURNING ci.id, s.price_id
			)
			INSERT INTO ${ITEMS_BACKUP} (item_id, old_price_id, new_price_id)
			SELECT id, NULL, price_id FROM items_upd
			ON CONFLICT (item_id) DO NOTHING`
		);
		// Precios creados que no quedaron vinculados (carrera improbable): se borran para no dejar huérfanos.
		await queryRunner.query(
			`DELETE FROM prices p WHERE p.holding_id = '${HOLDING_ID}' AND p.notes LIKE 'Migración 1791700000000:%'
				AND NOT EXISTS (SELECT 1 FROM contract_items ci WHERE ci.price_id = p.id)`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		const [exists] = (await queryRunner.query(`SELECT to_regclass('${ITEMS_BACKUP}') IS NOT NULL AS present`)) as Array<{ present: boolean }>;

		if (exists?.present) {
			await queryRunner.query(
				`UPDATE contract_items ci SET price_id = b.old_price_id FROM ${ITEMS_BACKUP} b WHERE ci.id = b.item_id AND ci.price_id = b.new_price_id`
			);
			await queryRunner.query(
				`DELETE FROM prices p USING ${ITEMS_BACKUP} b
				WHERE p.id = b.new_price_id AND NOT EXISTS (SELECT 1 FROM contract_items ci WHERE ci.price_id = p.id)`
			);
			await queryRunner.query(`DELETE FROM ${ITEMS_BACKUP} b WHERE NOT EXISTS (SELECT 1 FROM prices p WHERE p.id = b.new_price_id)`);
		}
		const [metrics] = (await queryRunner.query(`SELECT to_regclass('${METRICS_BACKUP}') IS NOT NULL AS present`)) as Array<{ present: boolean }>;

		if (metrics?.present) {
			await queryRunner.query(
				`WITH gone AS (
					DELETE FROM billable_metrics bm USING ${METRICS_BACKUP} b
					WHERE bm.id = b.metric_id AND NOT EXISTS (SELECT 1 FROM prices p WHERE p.billable_metric_id = bm.id)
					RETURNING bm.id
				)
				DELETE FROM ${METRICS_BACKUP} b USING gone g WHERE b.metric_id = g.id`
			);
		}
		for (const table of [ITEMS_BACKUP, METRICS_BACKUP]) {
			const [present] = (await queryRunner.query(`SELECT to_regclass('${table}') IS NOT NULL AS present`)) as Array<{ present: boolean }>;

			if (!present?.present) continue;
			const [left] = (await queryRunner.query(`SELECT count(*)::int AS n FROM ${table}`)) as Array<{ n: number }>;

			if (Number(left?.n ?? 0) === 0) await queryRunner.query(`DROP TABLE ${table}`);
		}
		await queryRunner.query(
			`DO $$ BEGIN IF to_regnamespace('${BACKUP_SCHEMA}') IS NOT NULL
				AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = '${BACKUP_SCHEMA}'::regnamespace) THEN DROP SCHEMA ${BACKUP_SCHEMA}; END IF; END $$`
		);
	}
}
