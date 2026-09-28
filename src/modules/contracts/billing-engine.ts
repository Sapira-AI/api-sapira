/**
 * Generador v2 de facturas de un contrato (`docs/v2-rediseno/mapa-v2-contratos.md` §3). Pieza **pura**: no lee ni escribe
 * la base. La usa la vista previa al crear (`POST /contracts/preview`) y la usará la activación (C2) para persistir
 * exactamente lo mismo que mostró.
 *
 * Reglas:
 * - Períodos desde el **día de ciclo** (default: día del `MIN(start_date)` de los recurrentes; si el mes es más corto,
 *   el último día). `fin = siguiente inicio − 1 día`.
 * - Frecuencias de **una sola tabla** (`BILLING_FREQUENCY_MONTHS`, Bianual = 24, S4-11).
 * - Anticipado emite al inicio del período; Vencido al inicio del siguiente.
 * - No recurrentes: **una sola vez**, al inicio, por el valor final completo (U6).
 * - Línea = cantidad × unitario del período (mensual × meses) × (1 − descuento %), con precio de lista y descuento
 *   visibles (nunca `1 × total`). Cuotas con 2 decimales y **la diferencia en la última** (S1-11): Σ cuotas = valor del ítem.
 * - Último período corto y primer tramo (inicio del ítem ≠ día de ciclo) **proporcionales por días** (manual §11, S4-16):
 *   fracción = días del tramo / días del mes de ciclo que lo contiene. El primer tramo va en la factura del primer ciclo.
 * - Encabezado = Σ líneas. IVA de la compañía salvo FACTURA_EXPORTACION (0) y Colombia (0 en Por Emitir: lo aplica Odoo).
 * - Moneda de factura (default: la del contrato). Misma moneda → FX 1; distinta → FX null y los montos quedan en moneda
 *   de contrato ("se valoriza al emitir"). Con tipo de cambio fijo (`fx_invoice_policy = 'fixed'`) cada factura toma la
 *   tasa que cubre el inicio de su período (`fixed_invoice_rates`, regla "1 [from] = rate [to]") y trae además sus montos
 *   en moneda de factura (`amounts_invoice_currency`); sin tasa, queda con FX null y advertencia.
 * - Vencimiento = emisión + condición de pago; México sin condición: emisión + 1 mes; sin condición: emisión + 30 días
 *   con advertencia. Nunca `+30` fijo cuando hay condición.
 * - Glosa `PRODUCTO Cuenta X - Periodo dd/mm/aaaa a dd/mm/aaaa`, solo guion ASCII.
 * - Agrupación: juntas (una factura por fecha de emisión) o por ítem (una por ítem y fecha).
 */

import type { PaymentTerms } from '@/databases/postgresql/entities/clientes/client-entity.entity';

/** Única tabla de frecuencias del sistema v2 (S4-11: Bianual = 24 meses). */
export const BILLING_FREQUENCY_MONTHS = { Mensual: 1, Trimestral: 3, Semestral: 6, Anual: 12, Bianual: 24 } as const;
export type BillingFrequency = keyof typeof BILLING_FREQUENCY_MONTHS;
export const BILLING_FREQUENCIES = Object.keys(BILLING_FREQUENCY_MONTHS) as BillingFrequency[];

export const BILLING_METHODS = ['Anticipado', 'Vencido'] as const;
export type BillingMethod = (typeof BILLING_METHODS)[number];

export type EngineDocumentType = 'FACTURA' | 'FACTURA_EXPORTACION';

export interface BillingEngineItem {
	/** Identificador del ítem en la entrada (lo genera el navegador); vuelve en `item_key`. */
	key: string;
	product_id?: string | null;
	product_name: string;
	account?: string | null;
	quantity: number;
	/** Precio unitario **mensual**. */
	unit_price: number;
	/** Porcentaje (0–100) salvo que `discount_type` sea `Monto fijo` (monto sobre el valor total del ítem). */
	discount_value?: number | null;
	discount_type?: 'Porcentaje' | 'Monto fijo' | string | null;
	billing_frequency: BillingFrequency | string;
	billing_method: BillingMethod | string;
	/** `YYYY-MM-DD`. */
	start_date: string;
	term_months: number;
	/** `YYYY-MM-DD`. Default: inicio + término − 1 día. */
	end_date?: string | null;
	is_recurring: boolean;
	/** Valor final del ítem, si ya viene calculado. Default: cantidad × unitario × término × (1 − descuento). */
	final_price?: number | null;
}

/** Fila de tasa fija por período (`contract_fx_period_rates`). Regla única: "1 [from_currency] = rate [to_currency]". */
export interface FxPeriodRate {
	from_currency: string;
	to_currency: string;
	rate: number | string;
	/** `YYYY-MM-DD`. */
	period_start: string;
	/** `YYYY-MM-DD`. */
	period_end: string;
	created_at?: string | null;
}

export interface BillingEngineContract {
	billing_anchor_day?: number | null;
	/** `true` (default) = juntas por fecha de emisión; `false` = una factura por ítem. */
	group_invoices_by_period?: boolean | null;
	invoice_currency?: string | null;
	contract_currency: string;
	fx_invoice_policy?: string | null;
	payment_terms?: PaymentTerms | null;
	/** Tasas fijas de facturación (`purpose = 'invoice'`); solo se usan con `fx_invoice_policy = 'fixed'`. */
	fixed_invoice_rates?: FxPeriodRate[] | null;
	document_type?: string | null;
	company: { country?: string | null; tax_rate?: number | string | null };
	entity_country?: string | null;
}

export interface BillingEngineInput {
	contract: BillingEngineContract;
	items: BillingEngineItem[];
}

export interface PreviewLine {
	item_key: string;
	product_name: string;
	description: string;
	quantity: number;
	unit_price: number;
	discount_pct: number;
	subtotal: number;
	tax_amount: number;
	total: number;
	billing_period_start: string;
	billing_period_end: string;
}

export interface PreviewInvoice {
	issue_date: string;
	due_date: string;
	billing_period_start: string;
	billing_period_end: string;
	document_type: EngineDocumentType;
	export_type: 0 | 1;
	currency: string;
	fx: number | null;
	tax_rate: number;
	lines: PreviewLine[];
	subtotal: number;
	tax: number;
	total: number;
	/** Solo con tipo de cambio fijo y tasa: neto, IVA y total en moneda de factura (espejo de `apply_fixed_fx_to_contract`). */
	amounts_invoice_currency?: { subtotal: number; tax: number; total: number };
}

export interface BillingEngineOutput {
	invoices: PreviewInvoice[];
	totals: { contract_value: number; invoiced_total: number; difference: number };
	warnings: string[];
}

// ------------------------------------------------------------------ dinero

/** Redondeo a 2 decimales "half away from zero" sin el error binario de `Math.round(x * 100)`. */
export const round2 = (value: number): number => {
	const sign = value < 0 ? -1 : 1;

	return (sign * Math.round(Number(`${Math.abs(value)}e2`) + Number.EPSILON)) / 100 || 0;
};
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6 || 0;

// ------------------------------------------------------------------ fechas (ISO `YYYY-MM-DD`, en UTC)

const DAY_MS = 86_400_000;

interface YMD {
	y: number;
	m: number; // 1–12
	d: number;
}

const parse = (iso: string): YMD => {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');

	if (!match) throw new Error(`Fecha inválida: ${iso}`);

	return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
};
const toIso = ({ y, m, d }: YMD) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const toTime = (iso: string) => {
	const { y, m, d } = parse(iso);

	return Date.UTC(y, m - 1, d);
};
const fromTime = (time: number) => new Date(time).toISOString().slice(0, 10);

export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const addDays = (iso: string, days: number) => fromTime(toTime(iso) + days * DAY_MS);
/** Días entre dos fechas (`to − from`). */
export const diffDays = (from: string, to: string) => Math.round((toTime(to) - toTime(from)) / DAY_MS);

/** Suma meses con el mismo criterio que Postgres (`date + interval 'n months'`): si el día no existe, el último del mes. */
export const addMonths = (iso: string, months: number) => {
	const { y, m, d } = parse(iso);
	const index = y * 12 + (m - 1) + months;
	const ny = Math.floor(index / 12);
	const nm = (index % 12) + 1;

	return toIso({ y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) });
};

/** Fin de un ítem: `inicio + término − 1 día` (mismo criterio que `set_contract_item_end_date`). */
export const itemEndDate = (start: string, termMonths: number) => addDays(addMonths(start, termMonths), -1);

/** Índice de mes absoluto (año × 12 + mes − 1). */
const monthIndex = (iso: string) => {
	const { y, m } = parse(iso);

	return y * 12 + (m - 1);
};
/** Fecha de ciclo del mes `index` con el día `anchor` (el último día si el mes es más corto). */
const anchorDate = (index: number, anchor: number) => {
	const y = Math.floor(index / 12);
	const m = (index % 12) + 1;

	return toIso({ y, m, d: Math.min(anchor, daysInMonth(y, m)) });
};

const formatDate = (iso: string) => {
	const { y, m, d } = parse(iso);

	return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
};

// ------------------------------------------------------------------ fiscal

const COUNTRY_ALIASES: Record<string, string> = {
	argentina: 'AR',
	ar: 'AR',
	brasil: 'BR',
	brazil: 'BR',
	br: 'BR',
	chile: 'CL',
	cl: 'CL',
	colombia: 'CO',
	co: 'CO',
	'costa rica': 'CR',
	cr: 'CR',
	ecuador: 'EC',
	ec: 'EC',
	'el salvador': 'SV',
	sv: 'SV',
	espana: 'ES',
	spain: 'ES',
	es: 'ES',
	'estados unidos': 'US',
	'united states': 'US',
	usa: 'US',
	eeuu: 'US',
	us: 'US',
	guatemala: 'GT',
	gt: 'GT',
	honduras: 'HN',
	hn: 'HN',
	mexico: 'MX',
	mx: 'MX',
	nicaragua: 'NI',
	ni: 'NI',
	panama: 'PA',
	pa: 'PA',
	paraguay: 'PY',
	py: 'PY',
	peru: 'PE',
	pe: 'PE',
	'puerto rico': 'PR',
	pr: 'PR',
	'reino unido': 'GB',
	'united kingdom': 'GB',
	uk: 'GB',
	gb: 'GB',
	'republica dominicana': 'DO',
	do: 'DO',
	uruguay: 'UY',
	uy: 'UY',
	'emiratos arabes': 'AE',
	'emiratos arabes unidos': 'AE',
	ae: 'AE',
};

/**
 * País a código ISO-2. La base guarda países escritos a mano ("México" y "Mexico", "Perú" y "Peru", "CR"…): se comparan
 * sin tildes, mayúsculas ni espacios de más. Desconocido → el texto normalizado (se compara igual contra sí mismo).
 */
export const normalizeCountry = (country: string | null | undefined): string | null => {
	const clean = String(country ?? '')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ');

	if (!clean) return null;

	return COUNTRY_ALIASES[clean] ?? clean.toUpperCase();
};

/** Tipo de documento sugerido (S1-7): país emisor ≠ país receptor → exportación. Sin uno de los dos países → FACTURA. */
export const suggestDocumentType = (companyCountry: string | null | undefined, entityCountry: string | null | undefined): EngineDocumentType => {
	const company = normalizeCountry(companyCountry);
	const entity = normalizeCountry(entityCountry);

	return company && entity && company !== entity ? 'FACTURA_EXPORTACION' : 'FACTURA';
};

/**
 * Tasa de IVA en porcentaje entero. `companies.tax_rate` convive en dos escalas (19 y 0,19, auditoría S4a): una tasa
 * ≤ 1 se interpreta como fracción.
 */
export const normalizeTaxRate = (taxRate: number | string | null | undefined): number | null => {
	if (taxRate === null || taxRate === undefined || taxRate === '') return null;
	const value = Number(taxRate);

	if (!Number.isFinite(value) || value < 0) return null;

	return round2(value > 0 && value <= 1 ? value * 100 : value);
};

// ------------------------------------------------------------------ vencimiento

/** Vencimiento de una factura según la condición de pago (forma de `client_entities.payment_terms`). */
export const computeDueDate = (issueDate: string, terms: PaymentTerms | null | undefined, companyCountry?: string | null): string => {
	if (terms?.kind === 'net') return addDays(issueDate, Number(terms.days) || 0);
	if (terms?.kind === 'end_of_month') {
		const { y, m } = parse(issueDate);

		return addDays(toIso({ y, m, d: daysInMonth(y, m) }), Number(terms.days) || 0);
	}
	if (terms?.kind === 'day_of_next_month') return anchorDate(monthIndex(issueDate) + 1, Number(terms.day) || 1);
	// México (SAT, PPD): sin condición, el mes siguiente.
	if (normalizeCountry(companyCountry) === 'MX') return addMonths(issueDate, 1);

	return addDays(issueDate, 30);
};

// ------------------------------------------------------------------ precios del ítem

/** Descuento del ítem como porcentaje (convierte `Monto fijo` sobre el valor bruto del ítem). */
export const discountPct = (item: Pick<BillingEngineItem, 'discount_value' | 'discount_type'>, grossValue: number): number => {
	const value = Number(item.discount_value ?? 0) || 0;

	if (value <= 0) return 0;
	if (item.discount_type === 'Monto fijo') return grossValue > 0 ? Math.min(100, (value / grossValue) * 100) : 0;

	return Math.min(100, value);
};

/** `price = unitario × cantidad × término` y `final_price = price × (1 − descuento %)` (mismo criterio que el front viejo). */
export const itemPricing = (item: Pick<BillingEngineItem, 'quantity' | 'unit_price' | 'term_months' | 'discount_value' | 'discount_type'>) => {
	const gross = (Number(item.unit_price) || 0) * (Number(item.quantity) || 0) * (Number(item.term_months) || 0);
	const pct = discountPct(item, gross);

	return { price: round2(gross), discount_pct: pct, final_price: round2(gross * (1 - pct / 100)) };
};

/** Día de ciclo por defecto: día del `MIN(start_date)` de los ítems recurrentes (o de todos si no hay recurrentes). */
export const defaultAnchorDay = (items: Array<Pick<BillingEngineItem, 'start_date' | 'is_recurring'>>): number | null => {
	const recurring = items.filter((item) => item.is_recurring && item.start_date);
	const pool = recurring.length ? recurring : items.filter((item) => item.start_date);

	if (!pool.length) return null;
	const first = pool.map((item) => item.start_date).sort()[0];

	return parse(first).d;
};

// ------------------------------------------------------------------ cuotas

interface Installment {
	item: BillingEngineItem;
	issue_date: string;
	period_start: string;
	period_end: string;
	/** Meses (fraccionarios en tramos) que cubre la cuota. */
	months: number;
	amount: number;
}

/** Meses que cubre `[start, end]` medidos en meses de ciclo: los completos cuentan 1 y el resto, días / días del mes de ciclo. */
export const monthsBetween = (start: string, end: string, anchor: number) => {
	// Mes de ciclo que contiene `start`.
	let index = monthIndex(start);

	if (anchorDate(index, anchor) > start) index -= 1;
	let cursor = start;
	let months = 0;

	while (cursor <= end) {
		const cycleStart = anchorDate(index, anchor);
		const next = anchorDate(index + 1, anchor);
		const cycleEnd = addDays(next, -1);
		const segmentEnd = end < cycleEnd ? end : cycleEnd;

		months += cursor === cycleStart && segmentEnd === cycleEnd ? 1 : (diffDays(cursor, segmentEnd) + 1) / diffDays(cycleStart, next);
		cursor = addDays(segmentEnd, 1);
		index += 1;
	}

	return months;
};

const recurringInstallments = (item: BillingEngineItem, anchor: number, monthlyNet: number): Installment[] => {
	const frequency = BILLING_FREQUENCY_MONTHS[item.billing_frequency as BillingFrequency] ?? 1;
	const vencido = item.billing_method === 'Vencido';
	const start = item.start_date;
	const end = item.end_date || itemEndDate(start, item.term_months);
	const installments: Installment[] = [];

	let index = monthIndex(start);
	let firstCycle = anchorDate(index, anchor);

	if (firstCycle < start) {
		index += 1;
		firstCycle = anchorDate(index, anchor);
	}

	// Primer tramo: el ítem parte antes del día de ciclo. Va en la factura del primer ciclo.
	if (firstCycle > start) {
		const stubEnd = end < addDays(firstCycle, -1) ? end : addDays(firstCycle, -1);
		const months = monthsBetween(start, stubEnd, anchor);

		installments.push({ item, issue_date: firstCycle, period_start: start, period_end: stubEnd, months, amount: monthlyNet * months });
	}

	for (let k = 0; ; k += 1) {
		const periodStart = anchorDate(index + k * frequency, anchor);

		if (periodStart > end) break;
		const nextStart = anchorDate(index + (k + 1) * frequency, anchor);
		const fullEnd = addDays(nextStart, -1);
		const periodEnd = fullEnd > end ? end : fullEnd;
		const months = periodEnd === fullEnd ? frequency : monthsBetween(periodStart, periodEnd, anchor);

		installments.push({
			item,
			issue_date: vencido ? addDays(periodEnd, 1) : periodStart,
			period_start: periodStart,
			period_end: periodEnd,
			months,
			amount: monthlyNet * months,
		});
	}

	return installments;
};

// ------------------------------------------------------------------ glosa

/** Glosa de la línea: `PRODUCTO Cuenta X - Periodo dd/mm/aaaa a dd/mm/aaaa`, solo guion ASCII. */
export const lineDescription = (productName: string, account: string | null | undefined, start: string, end: string) => {
	const accountText = account?.trim() ? ` Cuenta ${account.trim()}` : '';

	return `${productName.trim()}${accountText} - Periodo ${formatDate(start)} a ${formatDate(end)}`
		.replace(/[\u2012\u2013\u2014\u2015\u2212]/g, '-')
		.replace(/\s+/g, ' ')
		.trim();
};

// ------------------------------------------------------------------ tipo de cambio fijo

/**
 * Tasa fija de `from` a `to` para una fecha, con la regla única "1 [from] = rate [to]": primero la fila directa
 * (`from` → `to`) cuyo período contiene la fecha (la más reciente), si no la inversa como `1 / rate` (6 decimales).
 * Devuelve un **multiplicador** (monto en `to` = monto en `from` × tasa). `null` si ninguna fila cubre la fecha.
 */
export function findFixedRate(rates: FxPeriodRate[] | null | undefined, from: string, to: string, date: string): number | null {
	const upperText = (value: unknown) =>
		String(value ?? '')
			.trim()
			.toUpperCase();
	const covering = (rowFrom: string, rowTo: string) =>
		(rates ?? [])
			.filter(
				(row) =>
					upperText(row.from_currency) === rowFrom &&
					upperText(row.to_currency) === rowTo &&
					String(row.period_start).slice(0, 10) <= date &&
					String(row.period_end).slice(0, 10) >= date &&
					Number(row.rate) > 0
			)
			.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0];
	const direct = covering(upperText(from), upperText(to));

	if (direct) return Number(direct.rate);
	const inverse = covering(upperText(to), upperText(from));

	return inverse ? round6(1 / Number(inverse.rate)) : null;
}

/**
 * Montos en moneda de factura con tipo de cambio fijo, espejo de la rama "fixed" de `apply_fixed_fx_to_contract`:
 * encabezado `monto = neto × fx`, `IVA = round2(neto × fx × tasa / 100)`, `total = round2(neto × fx × (1 + tasa / 100))`;
 * líneas = cada monto en moneda de contrato × fx (unitario a 6 decimales; subtotal, IVA y total a 2, como sus columnas).
 */
export function fixedFxAmounts(invoice: Pick<PreviewInvoice, 'subtotal' | 'tax_rate' | 'lines'>, fx: number) {
	return {
		amount: round6(invoice.subtotal * fx),
		vat: round2((invoice.subtotal * fx * invoice.tax_rate) / 100),
		total: round2(invoice.subtotal * fx * (1 + invoice.tax_rate / 100)),
		lines: invoice.lines.map((line) => ({
			unit_price: round6(line.unit_price * fx),
			subtotal: round2(line.subtotal * fx),
			tax_amount: round2(line.tax_amount * fx),
			total: round2(line.total * fx),
		})),
	};
}

// ------------------------------------------------------------------ motor

export function generateInvoices({ contract, items }: BillingEngineInput): BillingEngineOutput {
	const warnings: string[] = [];
	const warn = (message: string) => {
		if (!warnings.includes(message)) warnings.push(message);
	};

	const valid = items.filter((item) => {
		const ok = Boolean(item.start_date) && Number(item.term_months) > 0 && Number(item.quantity) > 0;

		if (!ok) warn(`El ítem "${item.product_name}" no tiene inicio, plazo o cantidad válidos: no se incluye en la vista previa`);

		return ok;
	});
	const anchorInput = Number(contract.billing_anchor_day);
	const anchor = anchorInput >= 1 && anchorInput <= 31 ? Math.trunc(anchorInput) : (defaultAnchorDay(valid) ?? 1);

	// Fiscal
	const documentType: EngineDocumentType =
		contract.document_type === 'FACTURA' || contract.document_type === 'FACTURA_EXPORTACION'
			? contract.document_type
			: suggestDocumentType(contract.company.country, contract.entity_country);
	const exportType: 0 | 1 = documentType === 'FACTURA_EXPORTACION' ? 1 : 0;
	const companyTax = normalizeTaxRate(contract.company.tax_rate);
	let taxRate = 0;

	if (documentType === 'FACTURA_EXPORTACION') taxRate = 0;
	else if (normalizeCountry(contract.company.country) === 'CO') {
		taxRate = 0;
		warn('Compañía de Colombia: el IVA no se calcula en Por Emitir; lo aplica el ERP al emitir');
	} else if (companyTax === null) warn('La compañía no tiene tasa de IVA configurada: la vista previa va sin IVA');
	else taxRate = companyTax;

	// Moneda
	const contractCurrency = String(contract.contract_currency ?? '').toUpperCase();
	const currency = String(contract.invoice_currency || contractCurrency).toUpperCase();
	const fx = currency === contractCurrency ? 1 : null;
	const fixedFx = fx === null && contract.fx_invoice_policy === 'fixed';

	if (fx === null && !fixedFx) {
		warn(`Se factura en ${currency} y el contrato está en ${contractCurrency}: los montos están en ${contractCurrency} y se valorizan al emitir`);
	}
	if (!contract.payment_terms) {
		if (normalizeCountry(contract.company.country) === 'MX') warn('Sin condiciones de pago: vencimiento al mes siguiente de la emisión (México)');
		else warn('Sin condiciones de pago: vencimiento a 30 días');
	}

	// Cuotas por ítem, con redondeo por cuota y residuo en la última.
	const lines: Array<PreviewLine & { issue_date: string }> = [];
	let contractValue = 0;

	for (const item of valid) {
		const quantity = Number(item.quantity);
		const unit = Number(item.unit_price) || 0;
		const pricing = itemPricing(item);
		const target = item.final_price !== null && item.final_price !== undefined ? round2(Number(item.final_price)) : pricing.final_price;
		const pct = pricing.discount_pct;

		contractValue += target;

		let installments: Installment[];

		if (item.is_recurring) {
			installments = recurringInstallments(item, anchor, quantity * unit * (1 - pct / 100));
		} else {
			const end = item.end_date || itemEndDate(item.start_date, item.term_months);

			installments = [
				{ item, issue_date: item.start_date, period_start: item.start_date, period_end: end, months: item.term_months, amount: target },
			];
		}

		let accumulated = 0;

		installments.forEach((installment, position) => {
			const last = position === installments.length - 1;
			const subtotal = last ? round2(target - accumulated) : round2(installment.amount);

			if (last && Math.abs(subtotal - round2(installment.amount)) >= 1) {
				warn(`El último período de "${item.product_name}" se ajustó para que las cuotas sumen el valor del ítem`);
			}
			accumulated = round2(accumulated + subtotal);
			const taxAmount = round2((subtotal * taxRate) / 100);

			lines.push({
				issue_date: installment.issue_date,
				item_key: item.key,
				product_name: item.product_name,
				description: lineDescription(item.product_name, item.account, installment.period_start, installment.period_end),
				quantity,
				unit_price: round6(unit * installment.months),
				discount_pct: round6(pct),
				subtotal,
				tax_amount: taxAmount,
				total: round2(subtotal + taxAmount),
				billing_period_start: installment.period_start,
				billing_period_end: installment.period_end,
			});
		});
	}

	// Agrupación
	const together = contract.group_invoices_by_period !== false;
	const groups = new Map<string, typeof lines>();

	for (const line of lines) {
		const groupKey = together ? line.issue_date : `${line.issue_date}|${line.item_key}`;

		groups.set(groupKey, [...(groups.get(groupKey) ?? []), line]);
	}

	const keyOrder = new Map(valid.map((item, position) => [item.key, position]));
	const invoices: PreviewInvoice[] = [...groups.values()]
		.map((group) => {
			const sorted = [...group].sort(
				(a, b) =>
					(keyOrder.get(a.item_key) ?? 0) - (keyOrder.get(b.item_key) ?? 0) || a.billing_period_start.localeCompare(b.billing_period_start)
			);
			const issueDate = sorted[0].issue_date;
			const subtotal = round2(sorted.reduce((sum, line) => sum + line.subtotal, 0));
			const tax = round2(sorted.reduce((sum, line) => sum + line.tax_amount, 0));

			const invoice: PreviewInvoice = {
				issue_date: issueDate,
				due_date: computeDueDate(issueDate, contract.payment_terms, contract.company.country),
				billing_period_start: sorted.map((line) => line.billing_period_start).sort()[0],
				billing_period_end: sorted
					.map((line) => line.billing_period_end)
					.sort()
					.reverse()[0],
				document_type: documentType,
				export_type: exportType,
				currency,
				fx,
				tax_rate: taxRate,
				// eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-vars -- se descarta la fecha interna de agrupación
				lines: sorted.map(({ issue_date: _issueDate, ...line }) => line),
				subtotal,
				tax,
				total: round2(subtotal + tax),
			};

			if (fixedFx) {
				const rate = findFixedRate(contract.fixed_invoice_rates, contractCurrency, currency, invoice.billing_period_start);

				if (rate === null) {
					warn(
						`Tipo de cambio fijo: no hay tasa ${contractCurrency} → ${currency} para el período que empieza el ${formatDate(invoice.billing_period_start)}`
					);
				} else {
					const amounts = fixedFxAmounts(invoice, rate);

					invoice.fx = rate;
					invoice.amounts_invoice_currency = { subtotal: amounts.amount, tax: amounts.vat, total: amounts.total };
				}
			}

			return invoice;
		})
		.sort(
			(a, b) =>
				a.issue_date.localeCompare(b.issue_date) ||
				(keyOrder.get(a.lines[0].item_key) ?? 0) - (keyOrder.get(b.lines[0].item_key) ?? 0) ||
				a.billing_period_start.localeCompare(b.billing_period_start)
		);

	const invoicedTotal = round2(invoices.reduce((sum, invoice) => sum + invoice.subtotal, 0));
	const total = round2(contractValue);

	return {
		invoices,
		totals: { contract_value: total, invoiced_total: invoicedTotal, difference: round2(invoicedTotal - total) },
		warnings,
	};
}
