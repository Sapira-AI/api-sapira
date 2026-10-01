import { Logger } from '@nestjs/common';

import { INDEFINITE_HORIZON_PERIODS } from './billing-engine';

import type { QueryRunner } from 'typeorm';

/**
 * Campos que antes rellenaban triggers legacy y que, con la costura `sapira.writer = 'api'` (`api-writer.ts`), escribe la
 * API explícitamente. Cada función parte del trigger que reemplaza (nombrado en su comentario) y conserva su regla **salvo
 * donde el trigger tenía un bug documentado**: ahí aplica la regla v2 decidida y lo dice en su comentario ("Regla v2").
 * Inventario campo por campo, con el veredicto réplica / regla v2 / pendiente: `docs/v2-rediseno/activacion-campos-api.md`.
 * La aritmética de dinero en moneda del sistema corre en SQL (`ROUND` numérico) para coincidir al centavo con el trigger.
 */

type Row = Record<string, unknown>;
type Db = Pick<QueryRunner, 'query'>;

const logger = new Logger('ApiWrittenFields');

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNullableNumber = (value: unknown) => (value === null || value === undefined || value === '' ? null : Number(value));

/** `ROUND(x, n)` de Postgres (half away from zero), sin el error binario de `Math.round(x * 10^n)`. */
export const pgRound = (value: number, decimals: number): number => {
	if (!Number.isFinite(value)) return 0;
	const factor = 10 ** decimals;
	const sign = value < 0 ? -1 : 1;

	return (sign * Math.round(Math.abs(value) * factor + 1e-9)) / factor || 0;
};

/** Meses por período de facturación, como el `CASE LOWER(billing_frequency)` de los triggers de precio (desconocida = 1). */
export const frequencyMultiplier = (frequency: string | null | undefined): number => {
	switch ((frequency ?? 'mensual').toLowerCase()) {
		case 'trimestral':
			return 3;
		case 'semestral':
			return 6;
		case 'anual':
			return 12;
		case 'bianual':
			return 24;
		default:
			return 1;
	}
};

// ------------------------------------------------------------------ precios del ítem

export interface PricingFieldsInput {
	unit_price: number | null;
	annual_unit_price: number | null;
	/** Valor previo de la columna (UPDATE) o null (INSERT): el trigger lo conservaba si no había unitario. */
	annual_price?: number | null;
	price_entry_mode: string | null;
	quantity: number | null;
	billing_frequency: string | null;
	is_recurring: boolean | null;
	final_price: number | null;
	term_months: number | null;
	discount_type: string | null;
	discount_value: number | null;
	/** Solo `contract_items` (rama CHURN/DOWNSELL). */
	categoria?: string | null;
}

export interface PricingFields {
	unit_price: number | null;
	annual_unit_price: number | null;
	annual_price: number | null;
	price_entry_mode: string | null;
	monthly_price: number | null;
	billing_period_price: number | null;
}

/**
 * Mensual y precio por período (antes `calculate_monthly_and_period_prices`, IMMUTABLE). Misma regla salvo dos correcciones v2:
 * - **Pago único**: `billing_period_price` = el final completo (se factura una sola vez, U6 / mapa §3); el trigger lo repartía
 *   como final ÷ plazo × meses de la frecuencia, el "one shot en cada período".
 * - **Monto fijo sin término** (recurrente indefinido, S1-12): mensual = final ÷ meses del horizonte de 12 períodos (el mismo
 *   con que el generador mide el valor del ítem); el trigger caía a "base − descuento", que trata el monto del contrato como
 *   mensual.
 */
export function monthlyAndPeriodPrices(input: {
	unit_price: number | null;
	quantity: number | null;
	billing_frequency: string | null;
	is_recurring: boolean | null;
	final_price: number | null;
	term_months: number | null;
	discount_type: string | null;
	discount_value: number | null;
}): { monthly_price: number | null; billing_period_price: number } {
	const recurring = input.is_recurring === true;
	const multiplier = frequencyMultiplier(input.billing_frequency);
	let monthly: number | null = null;

	if (recurring) {
		const base = (input.unit_price ?? 0) * (input.quantity ?? 1);
		let value = base;

		if (input.discount_value !== null && input.discount_value > 0 && input.discount_type !== null) {
			if (input.discount_type === 'Porcentaje') value = base * (1 - input.discount_value / 100);
			else if (input.discount_type === 'Monto fijo')
				value =
					input.final_price !== null && input.term_months !== null && input.term_months > 0
						? input.final_price / input.term_months
						: input.final_price !== null && (input.term_months === null || input.term_months === undefined)
							? input.final_price / (INDEFINITE_HORIZON_PERIODS * frequencyMultiplier(input.billing_frequency))
							: base - input.discount_value;
		}
		monthly = Math.max(pgRound(value, 2), 0);
	}

	if (recurring) return { monthly_price: monthly, billing_period_price: pgRound((monthly ?? 0) * multiplier, 2) };

	return { monthly_price: null, billing_period_price: pgRound(input.final_price ?? 0, 2) };
}

/**
 * Precios derivados del ítem (antes `auto_calculate_pricing_fields`, BEFORE INSERT/UPDATE de `contract_items` y `quote_items`):
 * sincroniza anual ↔ mensual y deriva `monthly_price`/`billing_period_price`. La API la aplica a cada INSERT y a cada UPDATE
 * que toque las columnas que disparaban el trigger. Réplica del trigger salvo las reglas v2 marcadas (modo anual con
 * descuento acá; pago único y monto fijo sin término en `monthlyAndPeriodPrices`).
 */
export function pricingFields(input: PricingFieldsInput, table: 'contract_items' | 'quote_items'): PricingFields {
	let unitPrice = input.unit_price;
	let annualUnitPrice = input.annual_unit_price;
	let annualPrice = input.annual_price ?? null;
	let mode = input.price_entry_mode;

	if (mode === 'annual' && annualUnitPrice !== null) {
		unitPrice = pgRound(annualUnitPrice / 12, 6);
		annualPrice = pgRound(annualUnitPrice * (input.quantity ?? 1), 2);
	} else {
		if (unitPrice !== null) {
			annualUnitPrice = pgRound(unitPrice * 12, 6);
			annualPrice = pgRound(annualUnitPrice * (input.quantity ?? 1), 2);
		}
		if (mode === null) mode = 'monthly';
	}
	const base = { unit_price: unitPrice, annual_unit_price: annualUnitPrice, annual_price: annualPrice, price_entry_mode: mode };

	if (
		table === 'contract_items' &&
		['CHURN', 'DOWNSELL'].includes(input.categoria ?? '') &&
		(input.term_months ?? 0) > 0 &&
		input.final_price !== null
	) {
		const monthly = pgRound(input.final_price / input.term_months!, 2);

		return { ...base, monthly_price: monthly, billing_period_price: pgRound(monthly * frequencyMultiplier(input.billing_frequency), 2) };
	}
	const prices = monthlyAndPeriodPrices({ ...input, unit_price: unitPrice });
	let periodPrice = prices.billing_period_price;

	// Modo anual: el período sale del total anual (exacto al centavo, sin el redondeo del unitario ÷ 12). Regla v2 (bug del
	// trigger, `auto_calculate_pricing_fields.sql` rama "Override billing_period_price", auditoría S1 "modo anual con descuento
	// sin descuento"): el trigger ignoraba el descuento → `billing_period_price` bruto con `monthly_price` neto. Con % se aplica
	// el mismo % al total anual; con monto fijo el período queda mensual × meses (el mensual ya viene de final ÷ plazo).
	if (mode === 'annual' && annualPrice !== null && input.is_recurring === true) {
		const discounted = input.discount_value !== null && input.discount_value > 0 && input.discount_type !== null;

		if (!discounted) periodPrice = pgRound((annualPrice * frequencyMultiplier(input.billing_frequency)) / 12, 2);
		else if (input.discount_type === 'Porcentaje') {
			periodPrice = Math.max(
				pgRound((annualPrice * (1 - input.discount_value! / 100) * frequencyMultiplier(input.billing_frequency)) / 12, 2),
				0
			);
		}
	}

	return { ...base, monthly_price: prices.monthly_price, billing_period_price: periodPrice };
}

// ------------------------------------------------------------------ tipo de cambio a la moneda del sistema

/** Tasa contrato → sistema de `calculate_system_fx_rate` (lookup puro: tasas del holding o promedio mensual, con inversa). */
export async function systemFxRate(db: Db, holdingId: string, from: string, to: string, date: string, policy: string): Promise<number | null> {
	const [row] = (await db.query(`SELECT rate FROM calculate_system_fx_rate($1::uuid, $2, $3, $4::date, $5)`, [
		holdingId,
		from,
		to,
		date,
		policy,
	])) as Row[];

	return toNullableNumber(row?.rate);
}

/**
 * Sentido de la tasa que devuelve `calculate_system_fx_rate`, según la política (modelo FX v2, mapa §3b; auditoría S5b
 * "convenciones de dirección de tasa mezcladas"):
 * - `fixed_period` lee `holding_fx_period_rates`, guardada en forma **inversa** ("CLP → USD = 950": 950 CLP por 1 USD; la
 *   búsqueda inversa devuelve 1/tasa, que conserva esa forma) → el monto en moneda del sistema = monto **÷** tasa.
 * - `monthly_avg` lee `exchange_rates_monthly_avg`, **directa** ("CLP → USD = 0,0011": 1 CLP = 0,0011 USD; la inversa 1/tasa
 *   también queda directa) → monto **×** tasa.
 * Regla v2: los triggers dividían siempre, así que con `monthly_avg` el monto en sistema salía invertido (p. ej. CLP → USD
 * ~900.000 veces más grande; en prod, un contrato CLF de un holding CLP con `monthly_avg` quedó en 0,00). Con `fixed_period`
 * (los holdings en USD de hoy) el resultado no cambia.
 */
export const systemFxDivides = (policy: string | null | undefined) => (policy ?? 'monthly_avg') === 'fixed_period';

/** SQL del monto en moneda del sistema a partir de `amount` y la tasa `$rate`, en el sentido de `$divides` (boolean). */
const systemAmountSql = (amount: string, rateParam: number, dividesParam: number) =>
	`ROUND(CASE WHEN $${dividesParam}::boolean THEN ${amount} / NULLIF($${rateParam}::numeric, 0) ELSE ${amount} * $${rateParam}::numeric END, 2)`;

/**
 * IVA de un encabezado en porcentaje entero para SQL: `companies.tax_rate` (y las facturas que lo copiaron) conviven en dos
 * escalas (19 y 0,19, auditoría S4a / Tanda 2); misma regla que `normalizeTaxRate` del generador.
 */
export const taxRatePctSql = (column = 'tax_rate') =>
	`(CASE WHEN ${column} > 0 AND ${column} <= 1 THEN ${column} * 100 ELSE COALESCE(${column}, 0) END)`;
export const TAX_RATE_PCT_SQL = taxRatePctSql();

/**
 * Réplica de `auto_populate_invoice_fx_to_system` (BEFORE INSERT/UPDATE de `invoices`): `fx_contract_to_system`,
 * `system_currency`, `amount_system_currency` y `total_system_currency` de cada factura según la moneda del contrato, la
 * del sistema del holding (USD por defecto) y la política (`monthly_avg` por defecto) a la fecha de emisión (o programada,
 * u original, u hoy). Sin tasa: FX NULL y los montos quedan como estaban (nunca se completa con 1). Se llama después de
 * insertar o actualizar facturas en una transacción v2, con los ids tocados. Dos reglas v2 sobre el trigger: el sentido de la
 * tasa según la política (`systemFxDivides`) y el IVA normalizado a porcentaje (`TAX_RATE_PCT_SQL`: 0,19 → 19).
 */
export async function refreshInvoiceSystemAmounts(db: Db, holdingId: string, invoiceIds: string[]): Promise<void> {
	const ids = [...new Set(invoiceIds.filter(Boolean))];

	if (!ids.length) return;
	const rows = (await db.query(
		`SELECT i.id, c.contract_currency,
			COALESCE(i.issue_date, i.scheduled_at, i.original_issue_date, CURRENT_DATE)::text AS fx_date,
			COALESCE(hs.system_currency, 'USD') AS system_currency, COALESCE(hs.fx_system_policy, 'monthly_avg') AS fx_policy
		FROM invoices i
		JOIN contracts c ON c.id = i.contract_id
		LEFT JOIN LATERAL (SELECT system_currency, fx_system_policy FROM holding_settings WHERE holding_id = i.holding_id LIMIT 1) hs ON true
		WHERE i.id = ANY($1::uuid[]) AND i.holding_id = $2`,
		[ids, holdingId]
	)) as Row[];
	const rates = new Map<string, number | null>();

	for (const row of rows) {
		const contractCurrency = toText(row.contract_currency);

		if (!contractCurrency) continue;
		const systemCurrency = String(row.system_currency);

		if (contractCurrency === systemCurrency) {
			await db.query(
				`UPDATE invoices SET fx_contract_to_system = 1.0, system_currency = $3, amount_system_currency = amount_contract_currency,
					total_system_currency = ROUND(amount_contract_currency * (1 + ${TAX_RATE_PCT_SQL} / 100.0), 2)
				WHERE id = $1 AND holding_id = $2`,
				[row.id, holdingId, systemCurrency]
			);
			continue;
		}
		const fxDate = String(row.fx_date).slice(0, 10);
		const policy = String(row.fx_policy);
		const key = `${contractCurrency}|${systemCurrency}|${fxDate}|${policy}`;

		if (!rates.has(key)) rates.set(key, await systemFxRate(db, holdingId, contractCurrency, systemCurrency, fxDate, policy));
		const rate = rates.get(key) ?? null;

		if (rate === null) {
			logger.warn(`Sin tasa ${contractCurrency} → ${systemCurrency} al ${fxDate} (${policy}) para la factura ${String(row.id)}`);
			await db.query(`UPDATE invoices SET fx_contract_to_system = NULL, system_currency = $3 WHERE id = $1 AND holding_id = $2`, [
				row.id,
				holdingId,
				systemCurrency,
			]);
			continue;
		}
		const amount = systemAmountSql('amount_contract_currency', 3, 5);

		await db.query(
			`UPDATE invoices SET fx_contract_to_system = $3::numeric, system_currency = $4,
				amount_system_currency = ${amount},
				total_system_currency = ROUND(${amount} * (1 + ${TAX_RATE_PCT_SQL} / 100.0), 2)
			WHERE id = $1 AND holding_id = $2`,
			[row.id, holdingId, rate, systemCurrency, systemFxDivides(policy)]
		);
	}
}

/**
 * Montos en moneda del sistema de una **NC espejo** (regla v2, ROADMAP-OPERATIVO #10: "la NC debe replicar exacto la factura
 * original en negativo … fx de la original, independiente de la fecha de emisión"): la NC toma el `fx_contract_to_system`,
 * la moneda del sistema y la tasa efectiva de la original (monto de la NC × monto en sistema ÷ monto en contrato de la
 * original), así anula exactamente lo mismo en reportes. El trigger (y `refreshInvoiceSystemAmounts`) la valorizaba a la tasa
 * de la fecha de la NC. Si la original no tiene montos en sistema, cae a `refreshInvoiceSystemAmounts`.
 */
export async function mirrorInvoiceSystemAmounts(db: Db, holdingId: string, creditNoteId: string, originalId: string): Promise<void> {
	const amount = `ROUND(n.amount_contract_currency * o.amount_system_currency / o.amount_contract_currency, 2)`;
	const updated = (await db.query(
		`UPDATE invoices n SET fx_contract_to_system = o.fx_contract_to_system, system_currency = o.system_currency,
			amount_system_currency = ${amount},
			total_system_currency = ROUND(${amount} * (1 + ${taxRatePctSql('n.tax_rate')} / 100.0), 2)
		FROM invoices o
		WHERE n.id = $1 AND n.holding_id = $3 AND o.id = $2 AND o.holding_id = $3
			AND o.amount_system_currency IS NOT NULL AND COALESCE(o.amount_contract_currency, 0) <> 0
		RETURNING n.id`,
		[creditNoteId, originalId, holdingId]
	)) as Row[];

	if (!updated.length) await refreshInvoiceSystemAmounts(db, holdingId, [creditNoteId]);
}

/**
 * Réplica de `auto_calculate_contract_fx` → `calculate_contract_fx_amounts(uuid)`: `fx_rate_to_system`,
 * `total_value_system_currency` (= total ÷ o × tasa según la política, `systemFxDivides`: regla v2; el trigger dividía
 * siempre, 2 decimales) y `system_currency` del contrato, con la tasa a la fecha de booking (u hoy) y la política del holding. Como el trigger, **no bloquea**: sin moneda de sistema, sin tasa o si el UPDATE
 * falla (p. ej. el guard de período sobre `fx_rate_to_system`), deja el contrato como estaba y avisa. El UPDATE corre en un
 * SAVEPOINT para que un error no aborte la transacción. Devuelve si escribió.
 */
export async function refreshContractSystemFx(db: Db, contractId: string, holdingId: string): Promise<boolean> {
	const [contract] = (await db.query(
		`SELECT c.contract_currency, COALESCE(c.booking_date, CURRENT_DATE)::text AS fx_date, hs.system_currency,
			COALESCE(hs.fx_system_policy, 'monthly_avg') AS fx_policy
		FROM contracts c
		LEFT JOIN LATERAL (SELECT system_currency, fx_system_policy FROM holding_settings WHERE holding_id = c.holding_id LIMIT 1) hs ON true
		WHERE c.id = $1 AND c.holding_id = $2`,
		[contractId, holdingId]
	)) as Row[];
	const systemCurrency = toText(contract?.system_currency);

	if (!contract || !systemCurrency) {
		logger.warn(`FX a sistema del contrato ${contractId}: el holding no tiene moneda de sistema`);

		return false;
	}
	const contractCurrency = toText(contract.contract_currency);
	const rate =
		contractCurrency === systemCurrency
			? 1
			: contractCurrency
				? await systemFxRate(
						db,
						holdingId,
						contractCurrency,
						systemCurrency,
						String(contract.fx_date).slice(0, 10),
						String(contract.fx_policy)
					)
				: null;

	if (rate === null || rate === 0) {
		logger.warn(`FX a sistema del contrato ${contractId}: sin tasa ${contractCurrency} → ${systemCurrency} al ${String(contract.fx_date)}`);

		return false;
	}
	await db.query(`SAVEPOINT contract_system_fx`);
	try {
		await db.query(
			`UPDATE contracts SET fx_rate_to_system = $3::numeric, total_value_system_currency = ${systemAmountSql('total_value', 3, 5)},
				system_currency = $4
			WHERE id = $1 AND holding_id = $2`,
			[contractId, holdingId, rate, systemCurrency, systemFxDivides(toText(contract.fx_policy))]
		);
		await db.query(`RELEASE SAVEPOINT contract_system_fx`);

		return true;
	} catch (error) {
		await db.query(`ROLLBACK TO SAVEPOINT contract_system_fx`);
		logger.warn(`FX a sistema del contrato ${contractId} no aplicado: ${error instanceof Error ? error.message : String(error)}`);

		return false;
	}
}

/** Estados en los que `auto_calculate_contract_fx` calculaba el FX del contrato. */
const FX_STATUSES = ['Firmado', 'Activo'];

/**
 * Condición de `auto_calculate_contract_fx` en un UPDATE: el contrato entra a Firmado/Activo, o ya está ahí y cambió el
 * total, la moneda o el booking. `before`/`after` son la fila antes y después (status, total_value, contract_currency, booking_date).
 */
export function contractFxNeedsRefresh(before: Row | undefined, after: Row | undefined): boolean {
	if (!before || !after) return false;
	const statusAfter = toText(after.status) ?? '';

	if (!FX_STATUSES.includes(statusAfter)) return false;
	if (!FX_STATUSES.includes(toText(before.status) ?? '')) return true;
	const same = (key: string) => {
		const a = before[key];
		const b = after[key];

		if (key === 'total_value') return toNullableNumber(a) === toNullableNumber(b);

		return (toText(a)?.slice(0, 10) ?? null) === (toText(b)?.slice(0, 10) ?? null);
	};

	return !same('total_value') || !same('contract_currency') || !same('booking_date');
}

/**
 * `contract_items.categoria` de un ítem de borrador (antes `trg_set_contract_item_categoria` →
 * `calculate_contract_item_categoria`): NEW si el cliente no tiene contratos anteriores (creados antes que este), UPSELL si
 * el producto ya estaba en alguno, CROSS-SELL si no; NULL sin producto. Misma regla que la función, con una corrección v2:
 * **no cuenta los borradores borrados** (`deleted_at`, borrado lógico S2-9 que el front viejo no tenía: allí el borrado era
 * físico y el contrato desaparecía del historial). La clasificación a nivel cliente (REACTIVATION, borradores y cancelados
 * que hoy cuentan como "anteriores") es la decisión #9 abierta de `spec-modificaciones-contrato-v2.md` §8.
 */
export const itemCategoriaSql = (contractParam: number, productParam: number) => {
	const previous = `FROM contracts k JOIN contracts p ON p.client_id = k.client_id AND p.id <> k.id AND p.created_at < k.created_at
			AND p.deleted_at IS NULL`;

	return `CASE WHEN $${productParam}::uuid IS NULL THEN NULL
		WHEN NOT EXISTS (SELECT 1 ${previous} WHERE k.id = $${contractParam}::uuid) THEN 'NEW'
		WHEN EXISTS (SELECT 1 ${previous} JOIN contract_items pi ON pi.contract_id = p.id
			WHERE k.id = $${contractParam}::uuid AND pi.product_id = $${productParam}::uuid) THEN 'UPSELL'
		ELSE 'CROSS-SELL' END`;
};

/**
 * `contracts.term` (antes `update_contract_term`, AFTER INSERT/UPDATE/DELETE de `contract_items`): `MAX(term_months)` de los
 * ítems. Regla v2 (S1-12 / mapa §3, término indefinido): con algún recurrente sin término ni fin el contrato no tiene plazo
 * → NULL, igual que `contract_end_date`; el trigger ignoraba el NULL y dejaba el plazo del mayor ítem con término.
 */
export async function syncContractTerm(db: Db, contractId: string, holdingId: string): Promise<void> {
	await db.query(
		`UPDATE contracts c SET term = x.term
		FROM (SELECT CASE WHEN bool_or(COALESCE(is_recurring, true) AND term_months IS NULL AND end_date IS NULL) THEN NULL
				ELSE MAX(term_months) END AS term
			FROM contract_items WHERE contract_id = $1) x
		WHERE c.id = $1 AND c.holding_id = $2 AND c.term IS DISTINCT FROM x.term`,
		[contractId, holdingId]
	);
}

/**
 * `invoice_terms_and_conditions` de una factura nueva (antes `invoices_fill_terms_from_contract`): el texto propio si viene,
 * si no el del contrato. `$contract` y `$own` son los índices de los parámetros del INSERT.
 */
export const invoiceTermsSql = (contractParam: number, ownParam?: number) =>
	ownParam
		? `COALESCE($${ownParam}::text, (SELECT k.invoice_terms_and_conditions FROM contracts k WHERE k.id = $${contractParam}::uuid))`
		: `(SELECT k.invoice_terms_and_conditions FROM contracts k WHERE k.id = $${contractParam}::uuid)`;
