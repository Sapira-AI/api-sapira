/** Basta con `query` (DataSource, QueryRunner o el runner de una transacción). */
type Db = { query: (sql: string, params?: unknown[]) => Promise<unknown> };
type Row = Record<string, unknown>;

/**
 * Tipo de cambio contrato → sistema del **MRR histórico** (`mrr_legacy.fx_contract_to_system`) en TypeScript, para vistas previas que
 * deben mostrar el mismo monto en moneda de sistema que quedará guardado. Es la réplica exacta del trigger
 * `trg_calculate_mrr_legacy_system_currency` → `calculate_mrr_legacy_system_currency()` (no lee la marca `sapira.writer`: recalcula en
 * todo INSERT y en todo UPDATE que nombre `contract_currency`, `mrr_legacy` o `period_month`), que **no** es la misma regla que
 * `calculate_system_fx_rate` / `systemFxRate` de Contratos (esa invierte la búsqueda inversa, proyecta la tasa fija y multiplica con
 * `monthly_avg`). Mientras el trigger no cambie, el MRR histórico se convierte así:
 *
 * - misma moneda que la de sistema → 1;
 * - política `monthly_avg` (default): `exchange_rates_monthly_avg` del año y mes del período, par directo (contrato → sistema) o, si no
 *   está, la fila del par inverso **sin invertir**;
 * - política `fixed_period`: `holding_fx_period_rates` del holding cuyo rango cubre el período, directo o, si no, el inverso sin invertir;
 * - sin tasa (o sin `holding_settings`) → 1;
 * - monto en sistema = `mrr_legacy` ÷ tasa (siempre divide: las tasas fijas del holding se guardan "1 [sistema] = X [contrato]"),
 *   redondeado a 2 decimales como la columna.
 *
 * Si el trigger cambia, este archivo cambia en el mismo commit (lo vigila `mrr-historico-fx.spec.ts` contra el asset SQL).
 */
export interface LegacySystemFx {
	system_currency: string;
	/** Tasa por `MONEDA|AAAA-MM`. */
	rates: Map<string, number>;
}

export const legacyFxKey = (currency: string, month: string) => `${currency.toUpperCase()}|${month}`;

/** Monto en moneda de sistema como lo guarda el trigger: `round(mrr ÷ tasa, 2)`; `null` si no hay MRR. */
export function legacySystemAmount(mrr: number | null, rate: number): number | null {
	if (mrr === null) return null;

	return rate ? Math.round((mrr / rate) * 100) / 100 : null;
}

/** Tasas contrato → sistema del MRR histórico para cada par (moneda, mes `AAAA-MM`), con la regla del trigger. Una sola consulta. */
export async function loadLegacySystemFx(db: Db, holdingId: string, pairs: Array<{ currency: string; month: string }>): Promise<LegacySystemFx> {
	const unique = [...new Map(pairs.map((pair) => [legacyFxKey(pair.currency, pair.month), pair])).values()];
	const rows = (await db.query(
		`WITH hs AS (
			SELECT system_currency, COALESCE(fx_system_policy, 'monthly_avg') AS policy FROM holding_settings WHERE holding_id = $1
		), p AS (
			SELECT DISTINCT upper(x.currency) AS currency, x.month, to_date(x.month || '-01', 'YYYY-MM-DD') AS period_month
			FROM unnest($2::text[], $3::text[]) AS x(currency, month)
		)
		SELECT p.currency, p.month, (SELECT system_currency FROM hs) AS system_currency,
			CASE WHEN p.currency = (SELECT system_currency FROM hs) THEN 1.0
			ELSE COALESCE(CASE (SELECT policy FROM hs)
				WHEN 'monthly_avg' THEN COALESCE(
					(SELECT e.avg_rate FROM exchange_rates_monthly_avg e WHERE e.from_currency = p.currency AND e.to_currency = (SELECT system_currency FROM hs)
						AND e.year = EXTRACT(YEAR FROM p.period_month)::int AND e.month = EXTRACT(MONTH FROM p.period_month)::int LIMIT 1),
					(SELECT e.avg_rate FROM exchange_rates_monthly_avg e WHERE e.from_currency = (SELECT system_currency FROM hs) AND e.to_currency = p.currency
						AND e.year = EXTRACT(YEAR FROM p.period_month)::int AND e.month = EXTRACT(MONTH FROM p.period_month)::int LIMIT 1))
				WHEN 'fixed_period' THEN COALESCE(
					(SELECT r.rate FROM holding_fx_period_rates r WHERE r.holding_id = $1 AND r.from_currency = p.currency
						AND r.to_currency = (SELECT system_currency FROM hs) AND p.period_month >= r.period_start AND p.period_month <= r.period_end LIMIT 1),
					(SELECT r.rate FROM holding_fx_period_rates r WHERE r.holding_id = $1 AND r.from_currency = (SELECT system_currency FROM hs)
						AND r.to_currency = p.currency AND p.period_month >= r.period_start AND p.period_month <= r.period_end LIMIT 1))
				END, 1.0) END AS rate
		FROM p`,
		[holdingId, unique.map((pair) => pair.currency.toUpperCase()), unique.map((pair) => pair.month)]
	)) as Row[];
	const [settings] = rows.length
		? rows
		: ((await db.query(`SELECT system_currency FROM holding_settings WHERE holding_id = $1`, [holdingId])) as Row[]);

	return {
		system_currency: String(settings?.system_currency ?? 'USD'),
		rates: new Map(rows.map((row) => [legacyFxKey(String(row.currency), String(row.month)), Number(row.rate ?? 1) || 1])),
	};
}
