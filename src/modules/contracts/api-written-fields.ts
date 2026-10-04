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
 * Moneda en que está `invoices.amount_contract_currency` (alias `i` = factura, `c` = contrato): la del encabezado; sin ella, la del
 * contrato. Mayúsculas y sin espacios. Es la "moneda de contrato" de la regla por estado (Por Emitir) y del respaldo.
 */
export const INVOICE_HEADER_CURRENCY_SQL = `UPPER(TRIM(COALESCE(NULLIF(TRIM(i.contract_currency), ''), c.contract_currency)))`;

/** Estado de una factura que aún no es documento tributario: su monto en moneda de sistema sale de la moneda de contrato. */
export const INVOICE_PENDING_STATUS = 'Por Emitir';

/**
 * La factura tiene monto en moneda de factura (alias `i`): moneda y neto del documento. Un neto 0 con monto en contrato ≠ 0 cuenta como
 * "sin neto" (aún no se valorizó en moneda de factura); un documento en 0 en las dos monedas sí lo tiene.
 */
export const INVOICE_HAS_INVOICE_AMOUNT_SQL = `(i.amount_invoice_currency IS NOT NULL AND NULLIF(TRIM(i.invoice_currency), '') IS NOT NULL
	AND (i.amount_invoice_currency <> 0 OR COALESCE(i.amount_contract_currency, 0) = 0))`;

/**
 * Regla por estado (decisión de Domi 04-10, reemplaza la de "siempre moneda de factura" de la mañana y la "sin vueltas" del 01-10): la
 * factura se convierte desde la **moneda de factura** si ya es documento (cualquier estado salvo Por Emitir: Emitida, Enviada, Vencida,
 * Pagada, Cancelada, NC…) y tiene neto en esa moneda. Alias `i` = factura.
 */
export const INVOICE_FROM_INVOICE_CURRENCY_SQL = `(i.status IS DISTINCT FROM '${INVOICE_PENDING_STATUS}' AND ${INVOICE_HAS_INVOICE_AMOUNT_SQL})`;

/**
 * Moneda desde la que se convierte una factura a la moneda de sistema (alias `i` = factura, `c` = contrato): la de factura
 * (`INVOICE_FROM_INVOICE_CURRENCY_SQL`); si no —Por Emitir, o un documento sin neto en moneda de factura—, la moneda de contrato del
 * encabezado (`INVOICE_HEADER_CURRENCY_SQL`). Mayúsculas y sin espacios. La usan `refreshInvoiceSystemAmounts` y `recalculateHoldingFx`
 * (qué facturas recalcular al cambiar una tasa del holding).
 */
export const INVOICE_SYSTEM_SOURCE_CURRENCY_SQL = `(CASE WHEN ${INVOICE_FROM_INVOICE_CURRENCY_SQL} THEN UPPER(TRIM(i.invoice_currency)) ELSE ${INVOICE_HEADER_CURRENCY_SQL} END)`;

/**
 * Montos en moneda de sistema de cada factura (réplica con regla v2 de `auto_populate_invoice_fx_to_system`, BEFORE INSERT/UPDATE de
 * `invoices`): `fx_contract_to_system`, `system_currency`, `amount_system_currency` y `total_system_currency`. Se llama después de
 * insertar o actualizar facturas en una transacción v2, con los ids tocados.
 *
 * **Regla por estado (decisión de Domi 04-10):**
 * - **Por Emitir** (aún no hay documento): siempre desde la **moneda de contrato**, el monto del encabezado (`amount_contract_currency`
 *   en `invoices.contract_currency`; sin ella, la del contrato). En una unificada/consolidada multimoneda el encabezado ya está en la
 *   moneda de factura (no hay una sola moneda de contrato): se convierte ese monto.
 * - **Cualquier otro estado** (Emitida, Enviada, Vencida, Pagada, Cancelada, NC…): desde la **moneda de factura**, lo que realmente se
 *   cobra (`amount_invoice_currency` en `invoice_currency`). Sin neto en moneda de factura, el encabezado (respaldo).
 *
 * Conversión: `calculate_system_fx_rate(holding, moneda de origen, moneda de sistema, fecha, política)` a la fecha de emisión (o
 * programada, u original, u hoy) y la política del holding (`monthly_avg` por defecto), con el sentido de `systemFxDivides`. Misma
 * moneda que la de sistema → el mismo monto (FX 1). Total = monto en sistema × (1 + IVA %) (`TAX_RATE_PCT_SQL`: 0,19 → 19). Sin tasa:
 * FX NULL y los montos quedan como estaban (nunca se completa con 1). `fx_contract_to_system` conserva su nombre pero guarda la tasa
 * moneda de origen → sistema. Las líneas en moneda de sistema de una factura en otra moneda ya no entran "directo" (la regla "sin
 * vueltas" del 01-10 quedó reemplazada; las diferencias por tipo de cambio son un ítem de `ROADMAP-V2.md`).
 *
 * Al emitir (Por Emitir → Emitida), el monto pasa de la moneda de contrato a la de factura: la emisión la escribe el envío al ERP
 * (`InvoiceSchedulerService`) y el webhook del ERP (`OdooWebhookService`) sin la marca `sapira.writer`, así que el trigger recalcula en
 * ese mismo UPDATE de estado; una transacción v2 que cambie el estado llama esta función.
 *
 * Las NC espejo no pasan por aquí: copian la tasa de su factura original (`mirrorInvoiceSystemAmounts`).
 */
export async function refreshInvoiceSystemAmounts(db: Db, holdingId: string, invoiceIds: string[]): Promise<void> {
	const ids = [...new Set(invoiceIds.filter(Boolean))];

	if (!ids.length) return;
	const rows = (await db.query(
		`SELECT i.id, ${INVOICE_SYSTEM_SOURCE_CURRENCY_SQL} AS source_currency, ${INVOICE_FROM_INVOICE_CURRENCY_SQL} AS from_invoice,
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
		const sourceCurrency = toText(row.source_currency);

		if (!sourceCurrency) continue;
		const systemCurrency = String(row.system_currency);
		// Documento: neto en moneda de factura. Por Emitir (o sin neto): monto del encabezado en moneda de contrato.
		const fromInvoice = row.from_invoice === true || row.from_invoice === 't';
		const source = fromInvoice ? 'amount_invoice_currency' : 'amount_contract_currency';

		if (sourceCurrency === systemCurrency) {
			await db.query(
				`UPDATE invoices SET fx_contract_to_system = 1.0, system_currency = $3, amount_system_currency = ${source},
					total_system_currency = ROUND(${source} * (1 + ${TAX_RATE_PCT_SQL} / 100.0), 2)
				WHERE id = $1 AND holding_id = $2`,
				[row.id, holdingId, systemCurrency]
			);
			continue;
		}
		const fxDate = String(row.fx_date).slice(0, 10);
		const policy = String(row.fx_policy);
		const key = `${sourceCurrency}|${systemCurrency}|${fxDate}|${policy}`;

		if (!rates.has(key)) rates.set(key, await systemFxRate(db, holdingId, sourceCurrency, systemCurrency, fxDate, policy));
		const rate = rates.get(key) ?? null;

		if (rate === null) {
			logger.warn(`Sin tasa ${sourceCurrency} → ${systemCurrency} al ${fxDate} (${policy}) para la factura ${String(row.id)}`);
			await db.query(`UPDATE invoices SET fx_contract_to_system = NULL, system_currency = $3 WHERE id = $1 AND holding_id = $2`, [
				row.id,
				holdingId,
				systemCurrency,
			]);
			continue;
		}
		const amount = systemAmountSql(source, 3, 5);

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
 * La NC espejo `n` toma la tasa efectiva de su original `o` sobre el neto en moneda de factura si la original ya es documento (su monto en
 * sistema salió de la moneda de factura, regla por estado 04-10) y las dos comparten moneda de factura; si no, sobre el monto en contrato.
 */
export const MIRROR_BY_INVOICE_SQL = `n.amount_invoice_currency IS NOT NULL AND COALESCE(o.amount_invoice_currency, 0) <> 0
		AND o.status IS DISTINCT FROM '${INVOICE_PENDING_STATUS}' AND UPPER(TRIM(n.invoice_currency)) = UPPER(TRIM(o.invoice_currency))`;

/**
 * Montos en moneda del sistema de una **NC espejo** (regla v2, ROADMAP-OPERATIVO #10: "la NC debe replicar exacto la factura
 * original en negativo … fx de la original, independiente de la fecha de emisión"): la NC toma el `fx_contract_to_system`,
 * la moneda del sistema y la tasa efectiva de la original, así anula exactamente lo mismo en reportes. Tasa efectiva = monto en sistema ÷
 * neto en moneda de factura de la original, aplicada al neto en moneda de factura de la NC (regla por estado, 04-10) cuando la original
 * ya es documento y las dos tienen monto en la misma moneda de factura (`MIRROR_BY_INVOICE_SQL`); si no, monto en sistema ÷ monto en
 * contrato de la original sobre el monto en contrato de la NC (como antes). El trigger la valorizaba a la tasa de la fecha de la NC. Si la original no tiene montos en sistema, cae a
 * `refreshInvoiceSystemAmounts`.
 */
export async function mirrorInvoiceSystemAmounts(db: Db, holdingId: string, creditNoteId: string, originalId: string): Promise<void> {
	const byInvoice = MIRROR_BY_INVOICE_SQL;
	const amount = `ROUND(CASE WHEN ${byInvoice} THEN n.amount_invoice_currency * o.amount_system_currency / o.amount_invoice_currency
		ELSE n.amount_contract_currency * o.amount_system_currency / o.amount_contract_currency END, 2)`;
	const updated = (await db.query(
		`UPDATE invoices n SET fx_contract_to_system = o.fx_contract_to_system, system_currency = o.system_currency,
			amount_system_currency = ${amount},
			total_system_currency = ROUND(${amount} * (1 + ${taxRatePctSql('n.tax_rate')} / 100.0), 2)
		FROM invoices o
		WHERE n.id = $1 AND n.holding_id = $3 AND o.id = $2 AND o.holding_id = $3
			AND o.amount_system_currency IS NOT NULL AND (${byInvoice} OR COALESCE(o.amount_contract_currency, 0) <> 0)
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

/** Estados de un contrato que nunca se activó: no cuentan como contrato "anterior" del cliente (decisión 01-10, §9.1 #9). */
export const NEVER_ACTIVATED_STATUSES = ['En revisión', 'Borrador'] as const;
export const CANCELLED_STATUS = 'Cancelado';

/**
 * `contract_items.categoria` de un ítem de borrador (antes `trg_set_contract_item_categoria` → `calculate_contract_item_categoria`),
 * clasificación **a nivel cliente** (decisión de Domi 01-10, spec modificaciones §9.1 #9). Contratos "anteriores" = los del mismo cliente
 * creados antes que este, no borrados y **activados alguna vez** (los borradores — `En revisión` / `Borrador` — nunca cuentan):
 * - sin anteriores → `NEW`;
 * - todos los anteriores cancelados con el churn ya vigente (`status = Cancelado` y `churn_date` ≤ inicio del ítem o nulo) → `REACTIVATION`;
 * - si alguno sigue vigente → `UPSELL` si el producto estaba en alguno de los anteriores, `CROSS-SELL` si no.
 * NULL sin producto. Sin override manual. Espejo TS: `classifyClientItem`.
 */
export const itemCategoriaSql = (contractParam: number, productParam: number, startParam: number) => {
	const previous = `FROM contracts k JOIN contracts p ON p.client_id = k.client_id AND p.id <> k.id AND p.created_at < k.created_at
			AND p.deleted_at IS NULL AND p.status IS DISTINCT FROM '${NEVER_ACTIVATED_STATUSES[0]}' AND p.status IS DISTINCT FROM '${NEVER_ACTIVATED_STATUSES[1]}'`;

	return `CASE WHEN $${productParam}::uuid IS NULL THEN NULL
		WHEN NOT EXISTS (SELECT 1 ${previous} WHERE k.id = $${contractParam}::uuid) THEN 'NEW'
		WHEN NOT EXISTS (SELECT 1 ${previous} WHERE k.id = $${contractParam}::uuid
			AND NOT (p.status = '${CANCELLED_STATUS}' AND (p.churn_date IS NULL OR p.churn_date <= $${startParam}::date))) THEN 'REACTIVATION'
		WHEN EXISTS (SELECT 1 ${previous} JOIN contract_items pi ON pi.contract_id = p.id
			WHERE k.id = $${contractParam}::uuid AND pi.product_id = $${productParam}::uuid) THEN 'UPSELL'
		ELSE 'CROSS-SELL' END`;
};

/** Contrato del cliente para la clasificación a nivel cliente (`classifyClientItem`). */
export interface ClientContractRef {
	status: string | null;
	churn_date: string | null;
	product_ids: string[];
}

/**
 * Espejo TS de `itemCategoriaSql` (la usa `reactivate` rama c, §9.3.2): `previous` = los otros contratos del cliente (sin borrar). Los
 * borradores se ignoran; sin activados → `NEW`; todos cancelados con el churn vigente a `date` → `REACTIVATION`; si no, `UPSELL` /
 * `CROSS-SELL` según si el producto estaba en alguno. null sin producto.
 */
export function classifyClientItem(previous: ClientContractRef[], productId: string | null, date: string): string | null {
	if (!productId) return null;
	const activated = previous.filter((contract) => !(NEVER_ACTIVATED_STATUSES as readonly string[]).includes(contract.status ?? ''));

	if (!activated.length) return 'NEW';
	const live = activated.filter((contract) => !(contract.status === CANCELLED_STATUS && (!contract.churn_date || contract.churn_date <= date)));

	if (!live.length) return 'REACTIVATION';

	return activated.some((contract) => contract.product_ids.includes(productId)) ? 'UPSELL' : 'CROSS-SELL';
}

/** Espejos de baja y rebajas (mismo criterio que `liveRecurring` de `contract-changes.ts`): no cuentan para el fin del contrato. */
const REMOVAL_ITEM_CATEGORIES = new Set(['CHURN', 'DOWNSELL']);

export interface ContractEndItem {
	is_recurring?: boolean | null;
	end_date?: string | null;
	categoria?: string | null;
	churn_date?: string | null;
	renewed_by_item_id?: string | null;
}

/** Ítems recurrentes vivos para el fin del contrato: no son espejos de baja, no tienen baja (`churn_date`) ni fueron renovados. */
export const liveEndItems = <T extends ContractEndItem>(items: T[]): T[] =>
	items.filter(
		(item) =>
			item.is_recurring !== false &&
			!REMOVAL_ITEM_CATEGORIES.has(String(item.categoria ?? '').toUpperCase()) &&
			!item.churn_date &&
			!item.renewed_by_item_id
	);

/**
 * `contracts.contract_end_date`, **una sola regla** para alta, PUT, activación y toda modificación (decisión de Domi 01-10, cobertura D15 /
 * Huecos #5): el **mayor** `end_date` de los ítems recurrentes vivos; si alguno vivo es indefinido (sin fin) → `null`. `undefined` cuando no
 * queda ningún recurrente vivo (quien llama conserva el fin guardado, p. ej. `contract_cancel`). El "próximo vencimiento" de la lista es otro
 * valor derivado (`next_item_end_date`) y no usa esta regla.
 */
export function latestContractEnd(items: ContractEndItem[]): string | null | undefined {
	const live = liveEndItems(items);

	if (!live.length) return undefined;
	if (live.some((item) => !item.end_date)) return null;

	return live
		.map((item) => String(item.end_date).slice(0, 10))
		.sort()
		.reverse()[0];
}

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
