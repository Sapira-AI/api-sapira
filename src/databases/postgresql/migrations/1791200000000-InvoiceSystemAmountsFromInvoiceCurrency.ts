import { MigrationInterface, QueryRunner } from 'typeorm';

import { BACKUP_SCHEMA, CREATE_BACKUP_SCHEMA_SQL } from '../backups';

/**
 * Montos en moneda de sistema de las facturas con la **regla por estado** (decisión de Domi 04-10;
 * `docs/v2-rediseno/analisis-fx-y-mrr-historico.md` §4.2):
 * - **Por Emitir** (aún no hay documento): desde la **moneda de contrato**, el monto del encabezado (`amount_contract_currency` en
 *   `invoices.contract_currency`; sin ella, la del contrato).
 * - **Cualquier otro estado** (Emitida, Enviada, Vencida, Pagada, Cancelada, NC…): desde la **moneda de factura**, lo que realmente se
 *   cobra (`amount_invoice_currency` en `invoice_currency`).
 *
 * Conversión: `calculate_system_fx_rate(holding, moneda de origen, moneda de sistema, fecha, política)` a la fecha de emisión (o
 * programada, u original); misma moneda → el mismo monto. Total = monto en sistema × (1 + IVA %). Mismo cálculo que
 * `refreshInvoiceSystemAmounts` (API) y `auto_populate_invoice_fx_to_system` (trigger, que también recalcula al emitir). Solo escribe
 * `fx_contract_to_system`, `system_currency`, `amount_system_currency` y `total_system_currency`; folio, montos facturados, monedas,
 * estado y ERP no se tocan.
 *
 * **Alcance** (solo filas cuyo valor cambia; sin meses cerrados: la fecha de tipo de cambio desde el primer mes abierto de su compañía,
 * `get_cutoff_date` + 1 mes; con tasa: sin tasa no se toca):
 * 1. **Documentos** (todo estado salvo Por Emitir y Cancelada; incluidas las Pagadas de meses abiertos) con neto en moneda de factura
 *    y cuya conversión cambia con la regla: moneda de factura ≠ la del contrato, encabezado en otra moneda (unificadas multimoneda), neto
 *    en moneda de factura ≠ monto en contrato, o con líneas en moneda de sistema distinta de la de factura (regla "sin vueltas" anterior).
 *    Fuera, datos a corregir aparte: las que guardan el bruto como neto (`vat` ≠ 0, neto = total y ≠ Σ subtotales de sus líneas; en la
 *    copia del 04-10, 10 de TiMining, contrato EMI-01) y las que guardan en moneda de factura el monto del encabezado sin convertir
 *    (monedas distintas, mismo número, tasa contrato → factura ≠ 1; en la copia, 1 factura y 2 NC de SimpliRoute, 1 NC de uPlanner).
 * 2. **Por Emitir unificadas multimoneda** (encabezado en otra moneda que la del contrato): el trigger viejo convertía el monto del
 *    encabezado (en CLP) con la tasa de la moneda del contrato (USD o CLF). Desde la moneda de contrato del encabezado quedan bien. El
 *    resto de las Por Emitir **no se tocan** (ya están desde la moneda de contrato).
 *    Las **Canceladas** no entran: no suman en ningún reporte y varias traen montos inconsistentes entre monedas (en la copia, una NC
 *    de TiMining con −500.000 en contrato y −561,72 en factura); el trigger y la API les aplican la regla si se vuelven a tocar.
 * 3. **NC espejo** (con `related_invoice_id`, no Canceladas): copian la tasa efectiva de su original (`mirrorInvoiceSystemAmounts`), si la original cambió
 *    aquí o la NC está en otra moneda que su contrato.
 *
 * **Respaldo**: los valores anteriores quedan en `<BACKUP_SCHEMA>.invoice_system_fx_1791200000000` (`../backups.ts`: una constante para
 * todas las migraciones que respaldan; fuera de `public`, RLS sin policies). `down()` los restaura solo en las filas que siguen con los
 * valores de esta migración y borra la tabla si no queda nada pendiente.
 *
 * Guardas: exige el asset nuevo del trigger (si no, una edición desde el front actual o la emisión volverían a escribir otra regla); fija
 * `sapira.writer = 'api'` (local a la transacción) para que el trigger no recalcule encima; actualiza solo si algún valor cambia y el
 * respaldo conserva el primer valor (idempotente).
 */

/** El asset nuevo del trigger aplica la regla por estado: así se reconoce que ya está aplicado. */
const TRIGGER_MARKER = `IF NEW.status IS DISTINCT FROM 'Por Emitir'`;
const BACKUP_TABLE = `${BACKUP_SCHEMA}.invoice_system_fx_1791200000000`;
const PENDING = `'Por Emitir'`;
const CANCELLED = `'Cancelada'`;
const CREDIT_NOTE_SQL = (alias: string) => `${alias}.document_type ~* '^(NC|NOTA[[:space:]_-]*(DE[[:space:]_-]*)?CR[EÉ]DITO)'`;
/** Primer mes abierto de la compañía de la factura `alias` (sin cierre: todo abierto). */
const OPEN_FROM_SQL = (alias: string) =>
	`COALESCE((date_trunc('month', public.get_cutoff_date(${alias}.holding_id, ${alias}.company_id)) + interval '1 month')::date, '-infinity'::date)`;
const FX_DATE_SQL = (alias: string) => `COALESCE(${alias}.issue_date, ${alias}.scheduled_at, ${alias}.original_issue_date, CURRENT_DATE)`;
const TAX_PCT_SQL = (alias: string) =>
	`(CASE WHEN ${alias}.tax_rate > 0 AND ${alias}.tax_rate <= 1 THEN ${alias}.tax_rate * 100 ELSE COALESCE(${alias}.tax_rate, 0) END)`;
/** Moneda de contrato del encabezado (`invoices.contract_currency`; sin ella, la del contrato `c`). */
const HEADER_CCY_SQL = (alias: string) => `UPPER(TRIM(COALESCE(NULLIF(TRIM(${alias}.contract_currency), ''), c.contract_currency)))`;
const CHANGED_SQL = `(i.fx_contract_to_system IS DISTINCT FROM v.new_fx OR i.system_currency IS DISTINCT FROM v.new_system_currency
	OR i.amount_system_currency IS DISTINCT FROM v.new_amount OR i.total_system_currency IS DISTINCT FROM v.new_total)`;

/** Tasa, monto y total nuevos a partir de `base` (id, holding_id, source_currency, source_amount, tax_pct, system_currency, policy, fx_date). */
const CONVERT_SQL = (base: string) => `
	WITH base AS (${base}), rated AS (
		SELECT b.*, CASE WHEN b.source_currency = b.system_currency THEN 1.0
			ELSE (SELECT r.rate FROM public.calculate_system_fx_rate(b.holding_id, b.source_currency, b.system_currency, b.fx_date, b.policy) r) END AS rate
		FROM base b
	), calc AS (
		SELECT id, rate AS new_fx, system_currency AS new_system_currency,
			CASE WHEN source_currency = system_currency THEN source_amount
				ELSE ROUND(CASE WHEN policy = 'fixed_period' THEN source_amount / NULLIF(rate, 0) ELSE source_amount * rate END, 2) END AS new_amount, tax_pct
		FROM rated WHERE rate IS NOT NULL
	)
	SELECT id, new_fx, new_system_currency, new_amount, ROUND(new_amount * (1 + tax_pct / 100.0), 2) AS new_total FROM calc`;

const SETTINGS_SQL = `LEFT JOIN LATERAL (SELECT system_currency, fx_system_policy FROM holding_settings WHERE holding_id = i.holding_id LIMIT 1) hs ON true`;

/** 1 · Documentos (no Por Emitir, no NC espejo) del alcance, desde la moneda de factura. */
const INVOICES_SQL = CONVERT_SQL(`
		SELECT i.id, i.holding_id, UPPER(TRIM(i.invoice_currency)) AS source_currency, i.amount_invoice_currency AS source_amount,
			${TAX_PCT_SQL('i')} AS tax_pct, COALESCE(hs.system_currency, 'USD') AS system_currency,
			COALESCE(hs.fx_system_policy, 'monthly_avg') AS policy, ${FX_DATE_SQL('i')} AS fx_date
		FROM invoices i
		JOIN contracts c ON c.id = i.contract_id
		${SETTINGS_SQL}
		WHERE i.status IS DISTINCT FROM ${PENDING} AND i.status IS DISTINCT FROM ${CANCELLED}
			AND i.amount_invoice_currency IS NOT NULL AND NULLIF(TRIM(i.invoice_currency), '') IS NOT NULL
			AND (i.amount_invoice_currency <> 0 OR COALESCE(i.amount_contract_currency, 0) = 0)
			AND NOT (i.related_invoice_id IS NOT NULL AND ${CREDIT_NOTE_SQL('i')})
			AND ${FX_DATE_SQL('i')} >= ${OPEN_FROM_SQL('i')}
			AND NOT (COALESCE(i.vat, 0) <> 0 AND i.amount_invoice_currency = i.total_invoice_currency
				AND ABS(i.amount_invoice_currency - COALESCE((SELECT SUM(ii.subtotal_invoice_currency) FROM invoice_items ii WHERE ii.invoice_id = i.id), 0)) > 0.01)
			AND NOT (UPPER(TRIM(i.invoice_currency)) <> ${HEADER_CCY_SQL('i')}
				AND i.amount_invoice_currency = i.amount_contract_currency
				AND i.amount_invoice_currency <> 0 AND COALESCE(i.fx_contract_to_invoice, 1) <> 1)
			AND (UPPER(TRIM(i.invoice_currency)) <> UPPER(TRIM(c.contract_currency))
				OR ${HEADER_CCY_SQL('i')} <> UPPER(TRIM(c.contract_currency))
				OR ABS(i.amount_invoice_currency - COALESCE(i.amount_contract_currency, 0)) > 0.005
				OR EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id
					AND UPPER(TRIM(ii.contract_currency)) = UPPER(TRIM(COALESCE(hs.system_currency, 'USD')))
					AND UPPER(TRIM(ii.contract_currency)) <> UPPER(TRIM(i.invoice_currency))))`);

/** 2 · Por Emitir unificadas multimoneda (encabezado en otra moneda que el contrato), desde la moneda de contrato del encabezado. */
const PENDING_SQL = CONVERT_SQL(`
		SELECT i.id, i.holding_id, ${HEADER_CCY_SQL('i')} AS source_currency, i.amount_contract_currency AS source_amount,
			${TAX_PCT_SQL('i')} AS tax_pct, COALESCE(hs.system_currency, 'USD') AS system_currency,
			COALESCE(hs.fx_system_policy, 'monthly_avg') AS policy, ${FX_DATE_SQL('i')} AS fx_date
		FROM invoices i
		JOIN contracts c ON c.id = i.contract_id
		${SETTINGS_SQL}
		WHERE i.status = ${PENDING} AND i.amount_contract_currency IS NOT NULL
			AND NOT (i.related_invoice_id IS NOT NULL AND ${CREDIT_NOTE_SQL('i')})
			AND ${FX_DATE_SQL('i')} >= ${OPEN_FROM_SQL('i')}
			AND ${HEADER_CCY_SQL('i')} <> UPPER(TRIM(c.contract_currency))`);

/**
 * 3 · NC espejo: tasa efectiva de la original (neto en moneda de factura si la original ya es documento y comparten moneda de factura; si
 * no, monto en contrato). Mismo criterio que `MIRROR_BY_INVOICE_SQL` de la API.
 */
const CREDIT_NOTES_SQL = `
	SELECT n.id, o.fx_contract_to_system AS new_fx, o.system_currency AS new_system_currency, m.new_amount,
		ROUND(m.new_amount * (1 + ${TAX_PCT_SQL('n')} / 100.0), 2) AS new_total
	FROM invoices n
	JOIN invoices o ON o.id = n.related_invoice_id AND o.holding_id = n.holding_id
	JOIN contracts c ON c.id = n.contract_id
	CROSS JOIN LATERAL (SELECT ROUND(CASE
		WHEN n.amount_invoice_currency IS NOT NULL AND COALESCE(o.amount_invoice_currency, 0) <> 0 AND o.status IS DISTINCT FROM ${PENDING}
			AND UPPER(TRIM(n.invoice_currency)) = UPPER(TRIM(o.invoice_currency))
			THEN n.amount_invoice_currency * o.amount_system_currency / o.amount_invoice_currency
		WHEN COALESCE(o.amount_contract_currency, 0) <> 0 THEN n.amount_contract_currency * o.amount_system_currency / o.amount_contract_currency
		END, 2) AS new_amount) m
	WHERE n.status IS DISTINCT FROM ${CANCELLED} AND ${CREDIT_NOTE_SQL('n')}
		AND ${FX_DATE_SQL('n')} >= ${OPEN_FROM_SQL('n')}
		AND o.amount_system_currency IS NOT NULL AND m.new_amount IS NOT NULL
		AND NOT (UPPER(TRIM(n.invoice_currency)) <> ${HEADER_CCY_SQL('n')}
			AND n.amount_invoice_currency = n.amount_contract_currency AND n.amount_invoice_currency <> 0 AND COALESCE(n.fx_contract_to_invoice, 1) <> 1)
		AND (EXISTS (SELECT 1 FROM ${BACKUP_TABLE} b WHERE b.invoice_id = o.id AND b.kind IN ('invoice', 'pending'))
			OR UPPER(TRIM(n.invoice_currency)) <> UPPER(TRIM(c.contract_currency)))`;

/** Respaldo (primer valor) + actualización de las filas de `source` (id, new_fx, new_system_currency, new_amount, new_total). */
const applySql = (source: string, kind: 'invoice' | 'pending' | 'credit_note') => `
	WITH v AS (${source}),
	backup AS (
		INSERT INTO ${BACKUP_TABLE} (invoice_id, holding_id, kind, old_fx, old_system_currency, old_amount, old_total, new_fx, new_amount, new_total)
		SELECT i.id, i.holding_id, '${kind}', i.fx_contract_to_system, i.system_currency, i.amount_system_currency, i.total_system_currency,
			v.new_fx, v.new_amount, v.new_total
		FROM invoices i JOIN v ON v.id = i.id
		WHERE ${CHANGED_SQL}
		ON CONFLICT (invoice_id) DO NOTHING
	)
	UPDATE invoices i
	SET fx_contract_to_system = v.new_fx, system_currency = v.new_system_currency, amount_system_currency = v.new_amount, total_system_currency = v.new_total
	FROM v
	WHERE i.id = v.id AND ${CHANGED_SQL}
	RETURNING i.id`;

export class InvoiceSystemAmountsFromInvoiceCurrency1791200000000 implements MigrationInterface {
	name = 'InvoiceSystemAmountsFromInvoiceCurrency1791200000000';
	// Todo export de una migración debe ser su clase (schema-status.spec): lo que usan los tests se expone como estático.
	static readonly TRIGGER_MARKER = TRIGGER_MARKER;
	static readonly BACKUP_TABLE = BACKUP_TABLE;
	static readonly INVOICES_SQL = INVOICES_SQL;
	static readonly PENDING_SQL = PENDING_SQL;
	static readonly CREDIT_NOTES_SQL = CREDIT_NOTES_SQL;

	public async up(queryRunner: QueryRunner): Promise<void> {
		const [fn] = (await queryRunner.query(
			`SELECT pg_get_functiondef('public.auto_populate_invoice_fx_to_system()'::regprocedure) AS definition`
		)) as Array<{ definition: string }>;

		if (!String(fn?.definition ?? '').includes(TRIGGER_MARKER)) {
			throw new Error('Aplica primero el asset functions/auto_populate_invoice_fx_to_system.sql (regla por estado, 04-10).');
		}
		await queryRunner.query(`SELECT set_config('sapira.writer', 'api', true)`);
		for (const sql of CREATE_BACKUP_SCHEMA_SQL) await queryRunner.query(sql);
		await queryRunner.query(
			`CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (
				invoice_id uuid PRIMARY KEY,
				holding_id uuid NOT NULL,
				kind text NOT NULL,
				old_fx numeric, old_system_currency text, old_amount numeric, old_total numeric,
				new_fx numeric, new_amount numeric, new_total numeric,
				backed_up_at timestamptz NOT NULL DEFAULT now()
			)`
		);
		// Sin policies: con RLS activo, solo el dueño (la conexión de migraciones) la lee.
		await queryRunner.query(`ALTER TABLE ${BACKUP_TABLE} ENABLE ROW LEVEL SECURITY`);
		// Primero documentos y Por Emitir multimoneda; después las NC espejo, que leen la tasa ya corregida de su original.
		await queryRunner.query(applySql(INVOICES_SQL, 'invoice'));
		await queryRunner.query(applySql(PENDING_SQL, 'pending'));
		await queryRunner.query(applySql(CREDIT_NOTES_SQL, 'credit_note'));
	}

	/** Restaura los valores anteriores solo en las filas que siguen con los valores de esta migración. */
	public async down(queryRunner: QueryRunner): Promise<void> {
		const [exists] = (await queryRunner.query(`SELECT to_regclass('${BACKUP_TABLE}') IS NOT NULL AS present`)) as Array<{ present: boolean }>;

		if (!exists?.present) return;
		await queryRunner.query(`SELECT set_config('sapira.writer', 'api', true)`);
		await queryRunner.query(
			`WITH restored AS (
				UPDATE invoices i
				SET fx_contract_to_system = b.old_fx, system_currency = b.old_system_currency,
					amount_system_currency = b.old_amount, total_system_currency = b.old_total
				FROM ${BACKUP_TABLE} b
				WHERE i.id = b.invoice_id
					AND i.fx_contract_to_system IS NOT DISTINCT FROM b.new_fx
					AND i.amount_system_currency IS NOT DISTINCT FROM b.new_amount
					AND i.total_system_currency IS NOT DISTINCT FROM b.new_total
				RETURNING i.id
			)
			DELETE FROM ${BACKUP_TABLE} b USING restored r WHERE b.invoice_id = r.id`
		);
		const [left] = (await queryRunner.query(`SELECT count(*)::int AS n FROM ${BACKUP_TABLE}`)) as Array<{ n: number }>;

		// Si alguna fila cambió después de la migración, su respaldo se conserva para revisarla a mano. El esquema se borra solo si quedó
		// vacío (otra migración puede tener su respaldo ahí).
		if (Number(left?.n ?? 0) === 0) {
			await queryRunner.query(`DROP TABLE ${BACKUP_TABLE}`);
			await queryRunner.query(
				`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = '${BACKUP_SCHEMA}'::regnamespace) THEN DROP SCHEMA ${BACKUP_SCHEMA}; END IF; END $$`
			);
		}
	}
}
