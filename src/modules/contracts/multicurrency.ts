import { BadRequestException } from '@nestjs/common';

import type { FieldError } from '@/core/utils/validation-errors';

import { findFixedRate, type FxPeriodRate, round2 } from './billing-engine';

/**
 * Multimoneda en el contrato (`docs/v2-rediseno/spec-multimoneda-contrato.md`): códigos estables y conversiones puras que comparten el alta
 * (`contract-drafts.service.ts`), la activación, las modificaciones (`contract-changes.ts`) y el tipo de cambio por factura del 360.
 *
 * Tres monedas (§2): la **del ítem** (lo pactado), la **del contrato** (referencia interna: MRR, TCV, devengo) y la **de la factura** (la única
 * del documento). Facturar convierte directo ítem → factura por par (`purpose = 'invoice'`); las métricas convierten ítem → contrato con la
 * tasa fija pactada (`purpose = 'item'`). Regla única de toda tasa: "1 [from] = rate [to]".
 */
export const MULTICURRENCY_CODES = {
	/** 400: ítem en otra moneda que la del contrato sin `requires_multicurrency_billing`. */
	item_currency_requires_multicurrency: 'item_currency_requires_multicurrency',
	/** 400 / blocker: falta la tasa pactada ítem → contrato de un par. */
	item_fx_rate_missing: 'item_fx_rate_missing',
	/** 400: el precio (inline o de catálogo) no está en la moneda del ítem. */
	price_currency_mismatch: 'price_currency_mismatch',
	/** 400: cambiar la moneda de un contrato que ya tiene multimoneda activada (los ítems y sus tasas se pactaron contra la anterior). */
	multicurrency_contract_currency_locked: 'multicurrency_contract_currency_locked',
	/** Blocker de modificación: ítem en otra moneda sin el flag. */
	multicurrency_not_enabled: 'multicurrency_not_enabled',
	/** Blocker de modificación: apagar multimoneda con ítems en otra moneda. */
	foreign_currency_items_present: 'foreign_currency_items_present',
	/** 400: neto exacto en un documento con dos o más pares que convierten. */
	net_exact_multi_pair: 'net_exact_multi_pair',
} as const;

export const MULTICURRENCY_NOT_ENABLED_STEP = 'Activa multimoneda o usa la moneda del contrato';

export const upperCode = (value: unknown) =>
	String(value ?? '')
		.trim()
		.toUpperCase();

/** Clave de un par (`USD>CLP`), la misma que usa `rates_by_pair` del tipo de cambio por factura. */
export const pairKey = (from: string, to: string) => `${upperCode(from)}>${upperCode(to)}`;

/** Error de campo con su código estable (multimoneda). */
export interface CodedFieldError extends FieldError {
	code?: string;
}

/**
 * 400 con `message`, `errors[{ field, message }]` y `code` = el del primer error que lo traiga (mismo cuerpo que `validationException` más el
 * código). Cada error conserva también su `code` en el cuerpo de la excepción.
 */
export function codedValidationException(errors: CodedFieldError[]): BadRequestException {
	const code = errors.find((error) => error.code)?.code;

	return new BadRequestException({
		message: errors.map((error) => error.message).join(', ') || 'Error de validación',
		...(code ? { code } : {}),
		errors,
	});
}

/** Tasa ítem → contrato a una fecha: misma moneda → 1; sin fila → null (nunca 1). */
export const itemRate = (
	rates: FxPeriodRate[] | null | undefined,
	itemCurrency: string | null | undefined,
	contractCurrency: string,
	date: string
) => {
	const from = upperCode(itemCurrency) || upperCode(contractCurrency);

	return from === upperCode(contractCurrency) ? 1 : findFixedRate(rates, from, contractCurrency, date);
};

/** Un monto de un ítem en moneda de contrato con su tasa pactada (sin tasa → 0: el ítem no suma; el llamador ya bloqueó o avisó). */
export const toContractCurrency = (
	amount: number,
	itemCurrency: string | null | undefined,
	contractCurrency: string,
	rates: FxPeriodRate[] | null | undefined,
	date: string
) => {
	const rate = itemRate(rates, itemCurrency, contractCurrency, date);

	return rate === null ? 0 : round2(amount * rate);
};

/** Contexto de conversión de un contrato (MRR, TCV): moneda del contrato y tasas pactadas ítem → contrato. */
export interface ContractConversion {
	contract_currency: string;
	item_rates: FxPeriodRate[];
}

// ------------------------------------------------------------------ valorización por par de líneas existentes (Por Emitir)

/** Línea existente con sus montos en la moneda del ítem (`invoice_items.*_contract_currency`) y la moneda de origen. */
export interface PairLine {
	id: string;
	/** Moneda de la línea (`invoice_items.contract_currency` = moneda del ítem). */
	currency: string;
	unit_price: number;
	subtotal: number;
	tax_amount: number;
	/** Inicio del período de la línea (para elegir la tasa del par). */
	period_start: string;
}

export interface PairLineAmounts {
	id: string;
	currency: string;
	/** Tasa de la línea moneda del ítem → factura (1 mismo par, null = spot / sin tasa). */
	fx: number | null;
	unit_price: number | null;
	subtotal: number | null;
	tax: number | null;
	total: number | null;
}

export interface PairValuation {
	lines: PairLineAmounts[];
	/** Tasa del documento: la del único par convertidor (1 sin pares), null con dos o más o si ese par queda sin tasa. */
	fx: number | null;
	/** Pares convertidores (`USD>CLP`). */
	pairs: string[];
	/** Encabezado en moneda de factura = Σ líneas; null si alguna queda sin valorizar. */
	invoice: { subtotal: number; tax: number; total: number } | null;
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6 || 0;

/**
 * Valoriza por par las líneas de una Por Emitir de un contrato multimoneda (spec-multimoneda §4): la línea en la moneda de factura queda con
 * FX 1 y sus montos; las demás con la tasa de su par (`rateOf`) o NULL (spot). Residuo de centavos por par y tasa a la línea de mayor
 * subtotal; IVA por línea en moneda de factura (`subtotal × tasa del documento`); encabezado = Σ líneas.
 */
export function valuateLinesByPair(
	lines: PairLine[],
	invoiceCurrency: string,
	rateOf: (line: PairLine) => number | null,
	taxRate: number
): PairValuation {
	const target = upperCode(invoiceCurrency);
	const fxOf = lines.map((line) => (upperCode(line.currency) === target ? 1 : rateOf(line)));
	const subtotals = lines.map((line, index) =>
		fxOf[index] === null ? null : fxOf[index] === 1 ? line.subtotal : round2(line.subtotal * fxOf[index]!)
	);
	const groups = new Map<string, number[]>();

	lines.forEach((line, index) => {
		if (fxOf[index] === null || fxOf[index] === 1) return;
		const key = `${upperCode(line.currency)}|${fxOf[index]}`;

		groups.set(key, [...(groups.get(key) ?? []), index]);
	});
	for (const indexes of groups.values()) {
		const fx = fxOf[indexes[0]]!;
		const residual = round2(
			round2(indexes.reduce((sum, index) => sum + lines[index].subtotal, 0) * fx) -
				indexes.reduce((sum, index) => sum + (subtotals[index] ?? 0), 0)
		);

		if (residual !== 0) {
			const largest = indexes.reduce(
				(best, index) => (Math.abs(lines[index].subtotal) > Math.abs(lines[best].subtotal) ? index : best),
				indexes[0]
			);

			subtotals[largest] = round2(subtotals[largest]! + residual);
		}
	}
	const valued: PairLineAmounts[] = lines.map((line, index) => {
		const fx = fxOf[index];

		if (fx === null) return { id: line.id, currency: upperCode(line.currency), fx, unit_price: null, subtotal: null, tax: null, total: null };
		const subtotal = subtotals[index]!;
		const tax = fx === 1 ? line.tax_amount : round2((subtotal * taxRate) / 100);

		return {
			id: line.id,
			currency: upperCode(line.currency),
			fx,
			unit_price: fx === 1 ? line.unit_price : round6(line.unit_price * fx),
			subtotal,
			tax,
			total: round2(subtotal + tax),
		};
	});
	const converting = valued.filter((line) => line.currency !== target);
	const pairs = [...new Set(converting.map((line) => pairKey(line.currency, target)))];
	const rates = [...new Set(converting.map((line) => line.fx))];
	const all = valued.every((line) => line.subtotal !== null);
	const subtotal = round2(valued.reduce((sum, line) => sum + (line.subtotal ?? 0), 0));
	const tax = round2(valued.reduce((sum, line) => sum + (line.tax ?? 0), 0));

	return {
		lines: valued,
		fx: pairs.length === 0 ? 1 : pairs.length === 1 && rates.length === 1 ? rates[0] : null,
		pairs,
		invoice: all ? { subtotal, tax, total: round2(subtotal + tax) } : null,
	};
}

/** ¿El documento tiene líneas en monedas distintas de la del encabezado `contract_currency` (contrato multimoneda)? */
export const hasForeignLines = (lines: Array<{ currency?: string | null }>, contractCurrency: string | null | undefined) =>
	lines.some((line) => Boolean(line.currency) && upperCode(line.currency) !== upperCode(contractCurrency));

/** Línea guardada tal como la suma el encabezado multimoneda. */
export interface HeaderPairLine {
	currency: string | null;
	subtotal: number;
	tax: number;
	subtotal_invoice: number | null;
	tax_invoice: number | null;
	fx: number | null;
	period_start: string | null;
}

/**
 * Encabezado de una factura de un contrato multimoneda = Σ líneas (spec-multimoneda §3, convención `headerFromLines`):
 * - `amount_contract_currency` = Σ (subtotal de la línea en la moneda del ítem × tasa pactada ítem → contrato), redondeo por línea;
 * - todas las líneas valorizadas → monto, IVA y total en moneda de factura = Σ líneas; si alguna queda sin valorizar (spot) → NULL y `vat`
 *   en moneda de contrato (Σ IVA × tasa ítem → contrato), como el spot de siempre;
 * - `fx` del encabezado = la tasa del único par convertidor (1 sin pares), NULL con dos o más (se lee por línea).
 */
export function multicurrencyHeader(
	lines: HeaderPairLine[],
	context: { contract_currency: string; invoice_currency: string; item_rates: FxPeriodRate[]; fallback_date: string }
) {
	const contract = upperCode(context.contract_currency);
	const invoice = upperCode(context.invoice_currency) || contract;
	let amountContract = 0;
	let taxContract = 0;

	for (const line of lines) {
		const rate =
			itemRate(context.item_rates, line.currency || contract, contract, (line.period_start ?? context.fallback_date).slice(0, 10)) ?? 0;

		amountContract += round2(line.subtotal * rate);
		taxContract += round2(line.tax * rate);
	}
	const valued = lines.every((line) => line.subtotal_invoice !== null);
	const amountInvoice = round2(lines.reduce((sum, line) => sum + (line.subtotal_invoice ?? 0), 0));
	const taxInvoice = round2(lines.reduce((sum, line) => sum + (line.tax_invoice ?? 0), 0));
	const converting = lines.filter((line) => (upperCode(line.currency) || contract) !== invoice);
	const pairs = new Set(converting.map((line) => upperCode(line.currency) || contract));
	const rates = [...new Set(converting.map((line) => line.fx))];

	return {
		amount_contract_currency: round2(amountContract),
		vat: valued ? taxInvoice : round2(taxContract),
		amount_invoice_currency: valued ? amountInvoice : null,
		total_invoice_currency: valued ? round2(amountInvoice + taxInvoice) : null,
		fx: pairs.size === 0 ? 1 : pairs.size === 1 && rates.length === 1 ? rates[0] : null,
	};
}

// ------------------------------------------------------------------ revalorizar por par una Por Emitir editada (spec-multimoneda §4)

/**
 * Orígenes de tasa fijada **por factura** (`PATCH …/invoices/fx`: tasa manual o neto exacto): en un documento multimoneda la tasa de ese par en
 * ESE documento manda sobre la pactada del contrato. Mismo conjunto que `PER_INVOICE_FX_SOURCES` (`contract-changes.ts`; no se importa para no
 * crear un ciclo de módulos).
 */
export const DOCUMENT_RATE_SOURCES: ReadonlySet<string> = new Set(['manual', 'net_exact']);

/** Contexto de un contrato multimoneda para revalorizar sus Por Emitir (política, tasas por par y moneda de cada ítem). */
export interface PairRateContext {
	contract_currency: string;
	fx_invoice_policy: string | null;
	/** Tasas fijas de facturación por par (`purpose = 'invoice'`, moneda del ítem → factura). */
	invoice_rates: FxPeriodRate[];
	/** Tasas fijas pactadas ítem → contrato (`purpose = 'item'`, métricas y monto del encabezado en moneda de contrato). */
	item_rates: FxPeriodRate[];
	/** Moneda de cada ítem del contrato (`contract_items.currency`); la de la línea sale de aquí (nunca se reescribe). */
	item_currencies: Record<string, string>;
}

/** Línea de una Por Emitir tal como la revaloriza `revalueByPair`: montos en la moneda de la línea (= del ítem), su tasa y su origen. */
export interface RevalueLine {
	id: string;
	contract_item_id: string | null;
	/** Moneda guardada de la línea (`invoice_items.contract_currency`); null/ausente = la del contrato. */
	currency: string | null;
	/** Tasa guardada de la línea (`invoice_items.fx_contract_to_invoice`); undefined/null = sin tasa propia (línea nueva o spot). */
	fx: number | null;
	fx_rate_source: string | null;
	unit_price: number;
	subtotal: number;
	tax_amount: number;
	period_start: string | null;
}

export interface RevaluedLine extends PairLineAmounts {
	fx_rate_source: string | null;
}

export interface RevalueResult {
	lines: RevaluedLine[];
	/** Encabezado = Σ líneas (`multicurrencyHeader`): moneda de contrato con la tasa ítem → contrato, moneda de factura si todas valorizadas, FX del único par. */
	header: ReturnType<typeof multicurrencyHeader>;
	pairs: string[];
}

/** Moneda de una línea de un contrato multimoneda: la de su ítem (verdad pactada), si no la guardada, si no la del contrato. */
export const revalueLineCurrency = (
	line: { contract_item_id: string | null; currency?: string | null },
	context: Pick<PairRateContext, 'contract_currency' | 'item_currencies'>
) =>
	upperCode(line.contract_item_id ? context.item_currencies[line.contract_item_id] : null) ||
	upperCode(line.currency) ||
	upperCode(context.contract_currency);

/**
 * Revaloriza por par las líneas de una Por Emitir de un contrato multimoneda después de editarla (editor, masivo, reorganizar, facturar por OC,
 * reemisión, consumos), con la misma valorización por línea que el motor (`valuateLinesByPair`) y el encabezado = Σ líneas (`multicurrencyHeader`).
 * Tasa de cada línea: misma moneda que la factura → 1; si la línea conserva su moneda y ya tiene tasa → la suya (copia de la emitida, tasa
 * fijada antes); si no, la tasa fijada **por factura** para ese par en el documento (`manual` / `net_exact`, `DOCUMENT_RATE_SOURCES`); si no,
 * con política fija la pactada del par para el período de la línea (`findFixedRate`); si no (spot o sin tasa) → NULL y el encabezado en moneda
 * de factura queda NULL (nunca un documento medio valorizado).
 */
export function revalueByPair(
	lines: RevalueLine[],
	context: PairRateContext,
	invoice: { invoice_currency: string | null; tax_rate: number; fallback_date: string }
): RevalueResult {
	const contract = upperCode(context.contract_currency);
	const target = upperCode(invoice.invoice_currency) || contract;
	const currencyOf = new Map(lines.map((line) => [line.id, revalueLineCurrency(line, context)]));
	const documentRate = new Map<string, { fx: number; source: string }>();

	for (const line of lines) {
		const currency = currencyOf.get(line.id)!;

		if (currency === target || line.fx === null || line.fx === undefined || !DOCUMENT_RATE_SOURCES.has(line.fx_rate_source ?? '')) continue;
		if (upperCode(line.currency) && upperCode(line.currency) !== currency) continue;
		if (!documentRate.has(currency)) documentRate.set(currency, { fx: Number(line.fx), source: line.fx_rate_source! });
	}
	const sources = new Map<string, string | null>();
	const rateOf = (pairLine: PairLine): number | null => {
		const line = lines.find((row) => row.id === pairLine.id)!;
		const currency = pairLine.currency;
		const kept = upperCode(line.currency) === currency || (!line.currency && currency === contract);

		if (kept && line.fx !== null && line.fx !== undefined && Number(line.fx) > 0) {
			sources.set(line.id, line.fx_rate_source ?? 'contract');

			return Number(line.fx);
		}
		const document = documentRate.get(currency);

		if (document) {
			sources.set(line.id, document.source);

			return document.fx;
		}
		const fixed =
			context.fx_invoice_policy === 'fixed'
				? findFixedRate(context.invoice_rates, currency, target, pairLine.period_start || invoice.fallback_date)
				: null;

		sources.set(line.id, fixed === null ? null : 'contract');

		return fixed;
	};
	const valuation = valuateLinesByPair(
		lines.map((line) => ({
			id: line.id,
			currency: currencyOf.get(line.id)!,
			unit_price: line.unit_price,
			subtotal: line.subtotal,
			tax_amount: line.tax_amount,
			period_start: (line.period_start ?? invoice.fallback_date).slice(0, 10),
		})),
		target,
		rateOf,
		invoice.tax_rate
	);
	const revalued: RevaluedLine[] = valuation.lines.map((line) => ({
		...line,
		fx_rate_source:
			line.fx === null
				? null
				: line.currency === target
					? (lines.find((row) => row.id === line.id)!.fx_rate_source ?? 'contract')
					: (sources.get(line.id) ?? null),
	}));
	const header = multicurrencyHeader(
		revalued.map((line, index) => ({
			currency: line.currency,
			subtotal: lines[index].subtotal,
			tax: lines[index].tax_amount,
			subtotal_invoice: line.subtotal,
			tax_invoice: line.tax,
			fx: line.fx,
			period_start: lines[index].period_start,
		})),
		{ contract_currency: contract, invoice_currency: target, item_rates: context.item_rates, fallback_date: invoice.fallback_date }
	);

	return { lines: revalued, header, pairs: valuation.pairs };
}
