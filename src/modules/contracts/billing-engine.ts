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
 * - **Sin término** (S1-12 / M5): un recurrente con `term_months` null y sin `end_date` es indefinido. Supuesto: se generan
 *   facturas para un horizonte de `INDEFINITE_HORIZON_PERIODS` (12) períodos de su frecuencia desde el inicio, el valor del
 *   ítem se mide sobre ese mismo horizonte y la salida lleva `warning_codes: ['indefinite_horizon']` e `indefinite_until`.
 * - Línea = cantidad × unitario del período (mensual × meses) × (1 − descuento %), con precio de lista y descuento
 *   visibles (nunca `1 × total`). Cuotas con 2 decimales y **la diferencia en la última** (S1-11): Σ cuotas = valor del ítem.
 * - **Prorrateo** (manual §11, S4-16): si el día de ciclo ≠ día de inicio del ítem, el primer período va del inicio al día
 *   anterior al siguiente día de ciclo; si el fin (plazo o `end_date`) no cae en un fin de período, el último también es
 *   parcial. Un período parcial cobra `monto del período completo × meses cubiertos / meses de la frecuencia`, donde un mes
 *   parcial cuenta `días del tramo / días del mes de ciclo que lo contiene` (en Mensual: `días / días del período completo`).
 *   Montos a 2 decimales. Las líneas parciales llevan `prorated: true` y `prorated_days`, con la advertencia "Primer período
 *   prorrateado: N días" (o "Último…") y el código `prorated_period`. El primer tramo va en la factura del primer ciclo.
 * - Encabezado = Σ líneas. IVA de la compañía salvo FACTURA_EXPORTACION (0) y Colombia (0 en Por Emitir: lo aplica Odoo).
 * - Moneda de factura (default: la del contrato). Misma moneda → FX 1; distinta → FX null y los montos quedan en moneda
 *   de contrato ("se valoriza al emitir"). Con tipo de cambio fijo (`fx_invoice_policy = 'fixed'`) cada factura toma la
 *   tasa que cubre el inicio de su período (`fixed_invoice_rates`, regla "1 [from] = rate [to]") y trae además sus montos
 *   en moneda de factura (`amounts_invoice_currency`); sin tasa, queda con FX null y advertencia.
 * - **Multimoneda** (`spec-multimoneda-contrato.md` §4, decisiones 01-10): un ítem puede tener su moneda (`currency`, default la del
 *   contrato). Con algún ítem en otra moneda, la valorización es **por línea**: cada línea tiene su par (moneda del ítem → moneda de factura);
 *   mismo par → FX 1; fija → `findFixedRate(fixed_invoice_rates, moneda del ítem, moneda de factura, inicio del período de la línea)`; spot →
 *   FX null y montos en moneda de factura null hasta emitir. Residuo de centavos de cada par a su línea mayor; IVA por línea en moneda de
 *   factura. El encabezado en moneda de factura = Σ líneas solo si todas están valorizadas (si no, null); su FX = la tasa del único par
 *   convertidor, null con dos o más. El encabezado en moneda de contrato (`subtotal`, `tax`) y los totales (`contract_value`, `mrr`,
 *   `items[].monthly_equivalent`) convierten cada ítem con la tasa fija pactada ítem → contrato (`fixed_item_rates`, `purpose = 'item'`);
 *   sin tasa, el ítem no suma y queda en `fx_missing` (nunca 1). Sin ítems en otra moneda todo queda como antes (una tasa por factura).
 * - Vencimiento = emisión + condición de pago; México sin condición: emisión + 1 mes; sin condición: emisión + 30 días
 *   con advertencia. Nunca `+30` fijo cuando hay condición.
 * - Glosa `PRODUCTO Cuenta X - Periodo dd/mm/aaaa a dd/mm/aaaa`, solo guion ASCII, renderizada con la plantilla de descripción del
 *   contrato (`invoice-description.ts`, spec facturas §3.6); sin plantilla, `DEFAULT_TEMPLATE` produce exactamente esa glosa.
 * - Agrupación: juntas (una factura por fecha de emisión) o por ítem (una por ítem y fecha).
 * - Pricing v2 (`spec-pricing-v2.md` §4.1): un ítem con `price` distinto de "standard fijo" resuelve por cuota la cantidad
 *   del período (`resolveQuantity`) y la tarifa con `priceLine` (gratis → tramos → descuento → mínimo → tope); la línea
 *   lleva `quantity_source` y `pricing.breakdown`. El unitario de `standard`/`seat` es **por período** de la línea (no
 *   mensual). Con cantidad fija, un período parcial se prorratea igual que el estándar (subtotal y desglose × fracción); lo
 *   medido no se prorratea (el consumo ya es el del tramo). `totals.contract_value` suma solo lo fijo; lo medido aporta el
 *   mínimo comprometido por período (supuesto).
 * - **MRR** (`totals.mrr`, `items[].monthly_equivalent`): Σ del mensual equivalente de los recurrentes = monto de un período
 *   completo ÷ meses de la frecuencia, con la cantidad del ítem (en lo medido, la cantidad base) y el descuento del ítem. Es el
 *   mismo valor que guarda `contract_items.monthly_price` (ver `ContractDraftsService.equivalentMonthlyUnit`).
 * - Presentación (`spec-pricing-v2.md` §3.8): con `invoice_line_mode = single` (default) la línea es una, con el detalle por
 *   tramo en la glosa; con `per_tier` la cuota produce **varias** líneas (una por tramo/paquete/asiento más una por ajuste),
 *   todas del mismo ítem y período (`line_group`), cada una con su sub-desglose; Σ líneas = subtotal de la cuota.
 */

import type { PaymentTerms } from '@/databases/postgresql/entities/clientes/client-entity.entity';

import { DESCRIPTION_FITTED_CODE, type DescriptionContext, type DescriptionTemplate, fitDescription } from './invoice-description';
import {
	type ConsumptionInput,
	distributeTax,
	isMetered,
	isStandardFixed,
	type PricedLine,
	priceLine,
	type PriceSpec,
	type QuantitySource,
	resolveQuantity,
	splitInvoiceLines,
} from './pricing-engine';

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
	/** Plazo en meses. `null` (recurrente, sin `end_date`) = sin término: se factura un horizonte de 12 períodos. */
	term_months: number | null;
	/** `YYYY-MM-DD`. Default: inicio + término − 1 día (sin término: fin del horizonte). */
	end_date?: string | null;
	is_recurring: boolean;
	/** Valor final del ítem, si ya viene calculado. Default: cantidad × unitario × término × (1 − descuento). */
	final_price?: number | null;
	/** Pricing v2: modelo de precio del ítem. Ausente o "standard fijo" = el cálculo de hoy. */
	price?: PriceSpec | null;
	/** Pricing v2: consumos registrados del ítem (uno por período de la línea), para los precios medidos. */
	consumption?: ConsumptionInput[] | null;
	/** Multimoneda: moneda del ítem (precio, cantidad × unitario, consumos). Default: la del contrato. */
	currency?: string | null;
	/**
	 * Día de ciclo propio del ítem (`contract_items.billing_anchor_day`, spec modificaciones §9.3.9). `null`/ausente = ciclo del contrato.
	 * Con valor, sus cuotas parten ese día y no hay tramo prorrateado inicial (el ítem nace en su día de ciclo); se agrupa por fecha exacta.
	 */
	billing_anchor_day?: number | null;
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
	/** Tasas fijas de facturación (`purpose = 'invoice'`, por par moneda del ítem → factura); solo se usan con `fx_invoice_policy = 'fixed'`. */
	fixed_invoice_rates?: FxPeriodRate[] | null;
	/** Multimoneda: tasas fijas pactadas ítem → contrato (`purpose = 'item'`) para los totales en moneda de contrato (MRR, TCV, encabezado). */
	fixed_item_rates?: FxPeriodRate[] | null;
	/** Multimoneda: `requires_multicurrency_billing`; fuerza la valorización por línea aunque todos los ítems estén en la moneda del contrato. */
	multicurrency?: boolean | null;
	document_type?: string | null;
	company: { country?: string | null; tax_rate?: number | string | null };
	entity_country?: string | null;
	/** Plantilla de descripción del contrato (`contracts.invoice_description_template`, spec facturas §3.6); null = la glosa de hoy. */
	description_template?: DescriptionTemplate | null;
	/** Datos del contrato para los bloques de la plantilla (N° de contrato, razón social). */
	description_context?: { contract_number?: string | null; client_name?: string | null } | null;
	/**
	 * Límite de caracteres de la descripción del documento tributario (`description_max_chars`, SII = 80); null/ausente = sin límite. Las
	 * glosas generadas se ajustan a él en el origen (`fitDescription`, decisión 30-09) y la salida lleva `warning_codes: ['description_fitted']`.
	 */
	description_max_chars?: number | null;
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
	/** Pricing v2: de dónde salió la cantidad (`fixed` en las líneas de hoy). */
	quantity_source: QuantitySource;
	/** Pricing v2: desglose por tramo, solo en líneas con modelo de precio (en `per_tier`, el sub-desglose de esta fila). */
	pricing?: PricedLine;
	/** Pricing v2 `per_tier`: las filas de un mismo ítem y período comparten grupo (`item_key|period_start`). */
	line_group?: string;
	/** Pricing v2 `per_tier`: qué fila es dentro del grupo. */
	line_part?: { part: 'charge' | 'adjustment'; index: number; count: number };
	/** Período parcial (primer tramo o último período corto) cobrado en proporción a sus días. */
	prorated?: boolean;
	/** Días del período parcial (solo con `prorated`). */
	prorated_days?: number;
	/** Multimoneda (solo en contratos con ítems en otra moneda): moneda del ítem; los montos de la línea están en ella. */
	currency?: string;
	/** Multimoneda: tasa moneda del ítem → moneda de factura de la línea (1 mismo par, fija, null = spot se valoriza al emitir). */
	fx?: number | null;
	/** Multimoneda: origen de la tasa (`contract` = mismo par o fija del contrato; null = spot). */
	fx_rate_source?: 'contract' | null;
	/** Multimoneda: montos de la línea en moneda de factura (ausente si la línea es spot). */
	amounts_invoice_currency?: { unit_price: number; subtotal: number; tax: number; total: number };
}

/** Aporte de un ítem a los totales de la vista previa. */
export interface PreviewItemTotals {
	item_key: string;
	product_name: string;
	is_recurring: boolean;
	/** Mensual equivalente (0 si no es recurrente): monto de un período completo ÷ meses de la frecuencia, con descuento. */
	monthly_equivalent: number;
	/** Lo que el ítem suma a `totals.contract_value`. */
	value: number;
	/** Multimoneda (solo con ítems en otra moneda): moneda del ítem y montos en ella; `monthly_equivalent` y `value` van en moneda de contrato. */
	currency?: string;
	/** Multimoneda: tasa fija ítem → contrato usada (1 misma moneda; null = sin tasa, el ítem no suma). */
	item_fx_rate?: number | null;
	monthly_equivalent_item_currency?: number;
	value_item_currency?: number;
}

/** Tasa fija que falta para valorizar (multimoneda): `invoice` = ítem → factura (política fija), `item` = ítem → contrato (métricas). */
export interface FxMissingRate {
	purpose: 'invoice' | 'item';
	from_currency: string;
	to_currency: string;
	/** Primer inicio de período (`YYYY-MM-DD`) sin tasa para el par. */
	period_start: string;
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
	totals: { contract_value: number; invoiced_total: number; difference: number; mrr: number };
	/** Totales por ítem válido, en el orden de entrada (MRR y valor por ítem para el formulario). */
	items: PreviewItemTotals[];
	warnings: string[];
	/** Códigos estables de las advertencias que la UI distingue (`indefinite_horizon`, `prorated_period`, `description_fitted`). */
	warning_codes: string[];
	/** Con ítems sin término: última fecha del horizonte generado (`YYYY-MM-DD`); null si no hay. */
	indefinite_until: string | null;
	/** Líneas cuya glosa se ajustó al límite del documento (`description_fitted`). */
	description_fitted_lines?: number;
	/** Multimoneda: pares sin tasa fija (uno por propósito y par, con el primer período sin tasa). Vacío sin ítems en otra moneda. */
	fx_missing?: FxMissingRate[];
}

/** Aviso del generador cuando ajustó glosas al límite del documento (código `description_fitted`). */
export const descriptionFittedWarning = (count: number, maxChars: number | null) =>
	`${count} ${count === 1 ? 'descripción se ajustó' : 'descripciones se ajustaron'} automáticamente al límite de ${maxChars ?? ''} caracteres del documento`.replace(
		/\s+/g,
		' '
	);

/** Horizonte de facturación de un ítem sin término: 12 períodos de su frecuencia desde el inicio (supuesto, mapa §3). */
export const INDEFINITE_HORIZON_PERIODS = 12;
export const INDEFINITE_HORIZON_CODE = 'indefinite_horizon';
/** Hay al menos una línea prorrateada (primer o último período parcial). */
export const PRORATED_PERIOD_CODE = 'prorated_period';

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

/** Un recurrente sin plazo ni fin es indefinido (S1-12 / M5). */
export const isIndefiniteItem = (item: Pick<BillingEngineItem, 'term_months' | 'end_date' | 'is_recurring'>): boolean =>
	item.is_recurring !== false && (item.term_months === null || item.term_months === undefined) && !item.end_date;

/** Meses del horizonte de un ítem sin término: 12 períodos × meses de la frecuencia. */
export const indefiniteHorizonMonths = (item: Pick<BillingEngineItem, 'billing_frequency'>): number =>
	INDEFINITE_HORIZON_PERIODS * (BILLING_FREQUENCY_MONTHS[item.billing_frequency as BillingFrequency] ?? 1);

/** Plazo con el que se calcula el ítem: el suyo o, sin término, el del horizonte. */
export const effectiveTermMonths = (item: Pick<BillingEngineItem, 'term_months' | 'end_date' | 'is_recurring' | 'billing_frequency'>): number =>
	isIndefiniteItem(item) ? indefiniteHorizonMonths(item) : Number(item.term_months) || 0;

/** Fin del ítem para el generador: el guardado, el de su plazo o, sin término, el del horizonte. */
export const itemEffectiveEnd = (
	item: Pick<BillingEngineItem, 'start_date' | 'term_months' | 'end_date' | 'is_recurring' | 'billing_frequency'>
): string => item.end_date || itemEndDate(item.start_date, effectiveTermMonths(item));

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
export const itemPricing = (
	item: Pick<BillingEngineItem, 'quantity' | 'unit_price' | 'term_months' | 'discount_value' | 'discount_type'> &
		Partial<Pick<BillingEngineItem, 'billing_frequency'>>
) => {
	// Sin término (`term_months` null): el valor del ítem se mide sobre el horizonte de 12 períodos (supuesto, mapa §3).
	const months =
		item.term_months === null || item.term_months === undefined
			? indefiniteHorizonMonths({ billing_frequency: item.billing_frequency ?? 'Mensual' })
			: Number(item.term_months) || 0;
	const gross = (Number(item.unit_price) || 0) * (Number(item.quantity) || 0) * months;
	const pct = discountPct(item, gross);

	return { price: round2(gross), discount_pct: pct, final_price: round2(gross * (1 - pct / 100)) };
};

/** Día de ciclo 1–31 válido, o null. */
export const validAnchorDay = (value: unknown): number | null => {
	const day = Number(value);

	return value !== null && value !== undefined && Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
};

/** Día de ciclo con que se factura un ítem: el suyo (ciclo propio, §9.3.9) o el del contrato. */
export const itemAnchorDay = (item: Pick<BillingEngineItem, 'billing_anchor_day'>, contractAnchor: number): number =>
	validAnchorDay(item.billing_anchor_day) ?? contractAnchor;

/**
 * Día de ciclo por defecto: día del `MIN(start_date)` de los ítems recurrentes (o de todos si no hay recurrentes). Los ítems con ciclo
 * propio (§9.3.9) no fijan el ciclo del contrato salvo que sean los únicos.
 */
export const defaultAnchorDay = (items: Array<Pick<BillingEngineItem, 'start_date' | 'is_recurring' | 'billing_anchor_day'>>): number | null => {
	const contractCycle = items.filter((item) => !validAnchorDay(item.billing_anchor_day));
	const base = contractCycle.length ? contractCycle : items;
	const recurring = base.filter((item) => item.is_recurring && item.start_date);
	const pool = recurring.length ? recurring : base.filter((item) => item.start_date);

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

const recurringInstallments = (item: BillingEngineItem, contractAnchor: number, monthlyNet: number): Installment[] => {
	// Ciclo propio del ítem (§9.3.9): sus períodos parten su día; nace en él, así que no hay tramo inicial prorrateado.
	const anchor = itemAnchorDay(item, contractAnchor);
	const frequency = BILLING_FREQUENCY_MONTHS[item.billing_frequency as BillingFrequency] ?? 1;
	const vencido = item.billing_method === 'Vencido';
	const start = item.start_date;
	const end = itemEffectiveEnd(item);
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

/**
 * Períodos de servicio de un ítem recurrente con el día de ciclo del contrato (mismo cálculo que las cuotas del generador):
 * primer tramo si el inicio no cae en el día de ciclo y luego períodos completos por frecuencia hasta el fin. Lo usan las
 * modificaciones para ubicar "el próximo inicio de período" (S3-5/S3-6) sin duplicar la lógica.
 */
export const itemPeriods = (
	item: Pick<BillingEngineItem, 'start_date' | 'end_date' | 'term_months' | 'billing_frequency' | 'billing_method' | 'billing_anchor_day'>,
	anchor: number
): Array<{ issue_date: string; period_start: string; period_end: string; months: number }> =>
	recurringInstallments({ ...item, key: '', product_name: '', quantity: 1, unit_price: 0, is_recurring: true } as BillingEngineItem, anchor, 0).map(
		({ issue_date, period_start, period_end, months }) => ({ issue_date, period_start, period_end, months })
	);

/** Próximo inicio de período del ítem en o después de `date` (null si el ítem termina antes). */
export const nextPeriodStart = (
	item: Pick<BillingEngineItem, 'start_date' | 'end_date' | 'term_months' | 'billing_frequency' | 'billing_method' | 'billing_anchor_day'>,
	anchor: number,
	date: string
): string | null =>
	itemPeriods(item, anchor).find((period) => period.period_start >= date && period.period_start > item.start_date)?.period_start ?? null;

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

// ------------------------------------------------------------------ pricing v2: líneas con modelo de precio

/** Descuento del ítem en porcentaje para el motor de precios (solo `Porcentaje`; `Monto fijo` no aplica a un precio por tramos). */
const pricedDiscountPct = (item: BillingEngineItem, warn: (message: string) => void) => {
	const value = Number(item.discount_value ?? 0) || 0;

	if (value <= 0) return 0;
	if (item.discount_type === 'Monto fijo') {
		warn(`El descuento en monto fijo de "${item.product_name}" no aplica a un modelo de precio por consumo o tramos: se omite`);

		return 0;
	}

	return Math.min(100, value);
};

// ------------------------------------------------------------------ prorrateo y mensual equivalente

/** Días de un período `[start, end]`, ambos incluidos. */
export const periodDays = (start: string, end: string) => diffDays(start, end) + 1;

/** Una cuota es parcial si cubre otra cantidad de meses que la frecuencia (primer tramo o último período corto). */
const isPartialPeriod = (months: number, frequency: number) => Math.abs(months - frequency) > 1e-9;

/**
 * Línea tarifada de un período parcial: subtotal y desglose × `fraction` (meses cubiertos / meses de la frecuencia). El
 * subtotal se redondea a 2 decimales y el residuo de redondear las sublíneas va en la última de cargo (mismo criterio §3.6).
 */
export function prorateLine(priced: PricedLine, fraction: number): PricedLine {
	const subtotal = round2(priced.subtotal * fraction);
	const breakdown = priced.breakdown.map((subline) => ({ ...subline, amount: round2(subline.amount * fraction) }));
	const residue = round2(subtotal - breakdown.reduce((sum, subline) => sum + subline.amount, 0));

	if (residue !== 0 && breakdown.length) {
		const chargeKinds = new Set(['tier', 'package', 'seat']);
		let target = breakdown.length - 1;

		for (let index = breakdown.length - 1; index >= 0; index -= 1) {
			if (chargeKinds.has(breakdown[index].kind)) {
				target = index;
				break;
			}
		}
		breakdown[target] = { ...breakdown[target], amount: round2(breakdown[target].amount + residue) };
	}

	return { ...priced, subtotal, breakdown, effective_unit_price: priced.quantity > 0 ? round6(subtotal / priced.quantity) : 0 };
}

/**
 * Mensual equivalente de un ítem con modelo de precio: el subtotal de **un período completo** a la cantidad del ítem (en lo
 * medido, la cantidad base) con el descuento del ítem, dividido en los meses de la frecuencia (no recurrente: en su plazo).
 * Es lo que muestra el formulario como "Mensual" y lo que suma al MRR; `equivalentMonthlyUnit` guarda el mismo valor.
 */
export function pricedMonthlyEquivalent(
	price: PriceSpec,
	item: Pick<BillingEngineItem, 'quantity' | 'billing_frequency' | 'is_recurring' | 'term_months'>,
	discountPctValue = 0
): number {
	const quantity = Number(item.quantity) || 0;

	if (quantity <= 0) return 0;
	const months =
		item.is_recurring === false ? Number(item.term_months) || 1 : (BILLING_FREQUENCY_MONTHS[item.billing_frequency as BillingFrequency] ?? 1);

	return round6(priceLine(price, quantity, discountPctValue).subtotal / months);
}

/** Aviso de una cuota prorrateada ("Primer período prorrateado: 17 días…"); `first` = el tramo que parte en el inicio del ítem. */
const prorationWarning = (item: BillingEngineItem, start: string, end: string) =>
	`${start === item.start_date ? 'Primer' : 'Último'} período prorrateado: ${periodDays(start, end)} días ("${item.product_name}", ${formatDate(start)} a ${formatDate(end)})`;

/** Línea interna del motor: la fecha de emisión (para agrupar) y los datos de su descripción (se renderiza con el FX de la factura). */
type EngineLine = PreviewLine & { issue_date: string; desc: DescriptionContext };

/** ¿La cantidad de la línea ya es la final? (medida sin consumo cerrado → no: pending o estimated). */
const quantityFinal = (source: QuantitySource) => source !== 'pending' && source !== 'estimated';

/**
 * Cuotas de un ítem con modelo de precio (§4.1): por cada período, `resolveQuantity` → `priceLine`. Devuelve lo que aporta
 * al valor contratado: lo fijo suma sus subtotales; lo medido, el mínimo comprometido por período (o nada).
 */
function pricedLines(
	item: BillingEngineItem,
	anchor: number,
	taxRate: number,
	warn: (message: string) => void,
	lines: EngineLine[],
	onProrated: (start: string, end: string) => void
): number {
	const price = item.price!;
	const pct = pricedDiscountPct(item, warn);
	const end = itemEffectiveEnd(item);
	const term = effectiveTermMonths(item);
	const installments: Installment[] = item.is_recurring
		? recurringInstallments(item, anchor, 0)
		: [{ item, issue_date: item.start_date, period_start: item.start_date, period_end: end, months: term, amount: 0 }];
	const frequency = item.is_recurring ? (BILLING_FREQUENCY_MONTHS[item.billing_frequency as BillingFrequency] ?? 1) : term;
	let contractValue = 0;
	let pendingWarned = false;
	let partialWarned = false;

	for (const installment of installments) {
		const resolved = resolveQuantity(item, { start: installment.period_start, end: installment.period_end }, item.consumption ?? []);
		const fullPriced = priceLine(price, resolved.quantity, pct, {
			amount_override: resolved.amount_override,
			apply_item_discount: resolved.apply_item_discount,
			quantity_source: resolved.source,
		});
		// Período parcial con cantidad fija: se prorratea como el estándar. Lo medido no (el consumo ya es el del tramo).
		const partial = item.is_recurring && isPartialPeriod(installment.months, frequency);
		const prorate = partial && !isMetered(price);
		const priced = prorate ? prorateLine(fullPriced, installment.months / frequency) : fullPriced;
		const proration = prorate ? { prorated: true, prorated_days: periodDays(installment.period_start, installment.period_end) } : {};

		if (prorate) onProrated(installment.period_start, installment.period_end);

		if (resolved.source === 'pending' && !pendingWarned) {
			warn(`Consumo por informar en "${item.product_name}": la línea usa la cantidad base del ítem y se recalcula al registrar`);
			pendingWarned = true;
		}
		if (partial && !prorate && !partialWarned) {
			warn(
				`"${item.product_name}" tiene un período parcial (${formatDate(installment.period_start)} a ${formatDate(installment.period_end)}): el consumo se tarifa sin prorratear`
			);
			partialWarned = true;
		}
		priced.warnings.forEach(warn);
		contractValue += isMetered(price) ? Number(price.minimum_amount ?? 0) || 0 : priced.subtotal;
		const desc = {
			product_name: item.product_name,
			account: item.account ?? null,
			period_start: installment.period_start,
			period_end: installment.period_end,
			quantity_final: quantityFinal(resolved.source),
		};
		const common = {
			issue_date: installment.issue_date,
			item_key: item.key,
			product_name: item.product_name,
			discount_pct: round6(pct),
			billing_period_start: installment.period_start,
			billing_period_end: installment.period_end,
			quantity_source: resolved.source,
			...proration,
		};

		if (price.invoice_line_mode === 'per_tier') {
			// §3.8: una fila por tramo/paquete/asiento y una por ajuste; el IVA se reparte con el residuo en la última fila de cargo.
			const parts = splitInvoiceLines(priced);
			const taxes = distributeTax(
				parts.map((part) => part.subtotal),
				taxRate,
				parts.map((part) => part.part === 'charge')
			);

			parts.forEach((part, index) => {
				lines.push({
					...common,
					description: '',
					desc: {
						...desc,
						line_kind: 'per_tier',
						tier_label: part.label,
						quantity: part.quantity,
						unit_price: part.unit_price,
						amount: part.subtotal,
					},
					quantity: part.quantity,
					unit_price: part.unit_price,
					subtotal: part.subtotal,
					tax_amount: taxes[index],
					total: round2(part.subtotal + taxes[index]),
					pricing: { ...priced, subtotal: part.subtotal, effective_unit_price: part.unit_price, breakdown: part.breakdown, warnings: [] },
					line_group: `${item.key}|${installment.period_start}`,
					line_part: { part: part.part, index: part.index, count: part.count },
				});
			});
			continue;
		}
		const taxAmount = round2((priced.subtotal * taxRate) / 100);

		lines.push({
			...common,
			// §3.8 `single`: una línea, cantidad del período × unitario efectivo, con el detalle por tramo en la glosa (bloque `tier` detail).
			description: '',
			desc: {
				...desc,
				line_kind: 'single',
				breakdown: priced.breakdown,
				quantity: priced.quantity,
				unit_price: priced.effective_unit_price,
				amount: priced.subtotal,
			},
			quantity: priced.quantity,
			unit_price: priced.effective_unit_price,
			subtotal: priced.subtotal,
			tax_amount: taxAmount,
			total: round2(priced.subtotal + taxAmount),
			pricing: priced,
		});
	}

	return contractValue;
}

// ------------------------------------------------------------------ multimoneda (valorización por línea, spec-multimoneda §4)

const upperCode = (value: unknown) =>
	String(value ?? '')
		.trim()
		.toUpperCase();

/** Moneda de un ítem del generador (default: la del contrato). */
export const engineItemCurrency = (item: Pick<BillingEngineItem, 'currency'>, contractCurrency: string) =>
	upperCode(item.currency) || upperCode(contractCurrency);

/** Tasa fija ítem → contrato (`purpose = 'item'`) a una fecha: misma moneda → 1; sin fila → null (nunca 1). */
export const itemToContractRate = (rates: FxPeriodRate[] | null | undefined, itemCurrency: string, contractCurrency: string, date: string) =>
	upperCode(itemCurrency) === upperCode(contractCurrency) ? 1 : findFixedRate(rates, itemCurrency, contractCurrency, date);

/** Registro de pares sin tasa (uno por propósito y par, con el primer período sin tasa). */
class MissingRates {
	private readonly rows = new Map<string, FxMissingRate>();

	add(purpose: FxMissingRate['purpose'], from: string, to: string, periodStart: string) {
		const key = `${purpose}|${from}|${to}`;
		const current = this.rows.get(key);

		if (!current || periodStart < current.period_start)
			this.rows.set(key, { purpose, from_currency: from, to_currency: to, period_start: periodStart });
	}

	list(): FxMissingRate[] {
		return [...this.rows.values()].sort((a, b) => `${a.purpose}|${a.from_currency}`.localeCompare(`${b.purpose}|${b.from_currency}`));
	}
}

export interface MulticurrencyValuationContext {
	contract_currency: string;
	invoice_currency: string;
	fx_invoice_policy: string | null | undefined;
	fixed_invoice_rates: FxPeriodRate[] | null | undefined;
	fixed_item_rates: FxPeriodRate[] | null | undefined;
	tax_rate: number;
}

export interface MulticurrencyValuation {
	/** Encabezado en moneda de contrato (Σ líneas × tasa ítem → contrato, redondeo por línea). */
	subtotal: number;
	tax: number;
	total: number;
	/** Tasa del documento: la del único par convertidor (1 sin pares), null con dos o más o si ese par es spot / no tiene tasa. */
	fx: number | null;
	/** Encabezado en moneda de factura = Σ líneas; ausente si alguna línea queda sin valorizar (spot o sin tasa). */
	amounts_invoice_currency?: { subtotal: number; tax: number; total: number };
	/** Pares convertidores del documento (`USD>CLP`), en orden. */
	pairs: string[];
}

/**
 * Valoriza por línea un documento de un contrato multimoneda (spec-multimoneda §4): escribe en cada línea `currency`, `fx`, `fx_rate_source`
 * y `amounts_invoice_currency`, y devuelve el encabezado. Las líneas traen `currency` (moneda del ítem) y sus montos en esa moneda.
 * Residuo de convertir a tasa fija: por par y tasa, a la línea de mayor subtotal (Σ líneas = conversión exacta del par). IVA por línea en
 * moneda de factura con la tasa del documento (las líneas en la moneda de factura conservan el suyo).
 */
export function valuateMulticurrencyLines(
	lines: Array<PreviewLine & { currency: string }>,
	context: MulticurrencyValuationContext,
	onMissing: (purpose: FxMissingRate['purpose'], from: string, to: string, periodStart: string) => void = () => undefined
): MulticurrencyValuation {
	const contractCurrency = upperCode(context.contract_currency);
	const invoiceCurrency = upperCode(context.invoice_currency);
	const fixed = context.fx_invoice_policy === 'fixed';
	const fxOf = lines.map((line) => {
		const currency = upperCode(line.currency);

		if (currency === invoiceCurrency) return 1;
		if (!fixed) return null;
		const rate = findFixedRate(context.fixed_invoice_rates, currency, invoiceCurrency, line.billing_period_start);

		if (rate === null) onMissing('invoice', currency, invoiceCurrency, line.billing_period_start);

		return rate;
	});
	const subtotals = lines.map((line, index) => (fxOf[index] === null ? null : round2(line.subtotal * fxOf[index]!)));
	// Residuo por par y tasa: Σ líneas redondeadas = Σ en moneda del ítem × tasa (a 2 decimales), en la línea mayor del grupo.
	const groups = new Map<string, number[]>();

	lines.forEach((line, index) => {
		const fx = fxOf[index];

		if (fx === null || fx === 1) return;
		const key = `${upperCode(line.currency)}|${fx}`;

		groups.set(key, [...(groups.get(key) ?? []), index]);
	});
	for (const indexes of groups.values()) {
		const fx = fxOf[indexes[0]]!;
		const exact = round2(indexes.reduce((sum, index) => sum + lines[index].subtotal, 0) * fx);
		const rounded = indexes.reduce((sum, index) => sum + (subtotals[index] ?? 0), 0);
		const residual = round2(exact - rounded);

		if (residual !== 0) {
			const largest = indexes.reduce(
				(best, index) => (Math.abs(lines[index].subtotal) > Math.abs(lines[best].subtotal) ? index : best),
				indexes[0]
			);

			subtotals[largest] = round2(subtotals[largest]! + residual);
		}
	}
	let invoiceSubtotal = 0;
	let invoiceTax = 0;
	let allValued = true;
	let headerSubtotal = 0;
	let headerTax = 0;

	lines.forEach((line, index) => {
		const currency = upperCode(line.currency);
		const fx = fxOf[index];

		line.currency = currency;
		line.fx = fx;
		line.fx_rate_source = fx === null ? null : 'contract';
		if (fx === null) {
			delete line.amounts_invoice_currency;
			allValued = false;
		} else {
			const subtotal = subtotals[index]!;
			const tax = fx === 1 ? line.tax_amount : round2((subtotal * context.tax_rate) / 100);

			line.amounts_invoice_currency = {
				unit_price: fx === 1 ? line.unit_price : round6(line.unit_price * fx),
				subtotal,
				tax,
				total: round2(subtotal + tax),
			};
			invoiceSubtotal += subtotal;
			invoiceTax += tax;
		}
		const toContract = itemToContractRate(context.fixed_item_rates, currency, contractCurrency, line.billing_period_start);

		if (toContract === null) onMissing('item', currency, contractCurrency, line.billing_period_start);
		else {
			headerSubtotal += round2(line.subtotal * toContract);
			headerTax += round2(line.tax_amount * toContract);
		}
	});
	const pairs = [...new Set(lines.map((line) => upperCode(line.currency)).filter((currency) => currency !== invoiceCurrency))].map(
		(currency) => `${currency}>${invoiceCurrency}`
	);
	let fx: number | null = 1;

	if (pairs.length === 1) {
		const rates = [...new Set(lines.filter((line) => upperCode(line.currency) !== invoiceCurrency).map((line) => line.fx ?? null))];

		fx = rates.length === 1 ? rates[0] : null;
	} else if (pairs.length > 1) fx = null;
	const subtotal = round2(headerSubtotal);
	const tax = round2(headerTax);

	return {
		subtotal,
		tax,
		total: round2(subtotal + tax),
		fx,
		...(allValued
			? {
					amounts_invoice_currency: {
						subtotal: round2(invoiceSubtotal),
						tax: round2(invoiceTax),
						total: round2(round2(invoiceSubtotal) + round2(invoiceTax)),
					},
				}
			: {}),
		pairs,
	};
}

// ------------------------------------------------------------------ motor

export function generateInvoices({ contract, items }: BillingEngineInput): BillingEngineOutput {
	const warnings: string[] = [];
	const warn = (message: string) => {
		if (!warnings.includes(message)) warnings.push(message);
	};

	const warningCodes: string[] = [];
	const flag = (code: string) => {
		if (!warningCodes.includes(code)) warningCodes.push(code);
	};
	const valid = items.filter((item) => {
		// Válido con plazo, con fin explícito o sin término (recurrente indefinido).
		const ok =
			Boolean(item.start_date) &&
			(isIndefiniteItem(item) || Boolean(item.end_date) || Number(item.term_months) > 0) &&
			Number(item.quantity) > 0;

		if (!ok) warn(`El ítem "${item.product_name}" no tiene inicio, plazo o cantidad válidos: no se incluye en la vista previa`);

		return ok;
	});
	// Sin término: horizonte de 12 períodos por ítem; la UI lo distingue por `indefinite_horizon` y la última fecha cubierta.
	let indefiniteUntil: string | null = null;

	for (const item of valid.filter(isIndefiniteItem)) {
		const until = itemEffectiveEnd(item);

		if (!indefiniteUntil || until > indefiniteUntil) indefiniteUntil = until;
		flag(INDEFINITE_HORIZON_CODE);
		warn(
			`"${item.product_name}" no tiene término: se generan facturas hasta el ${formatDate(until)} (${INDEFINITE_HORIZON_PERIODS} períodos); las siguientes se generan después`
		);
	}
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
	// Multimoneda: con algún ítem en otra moneda que la del contrato, la valorización es por línea (spec-multimoneda §4).
	const lineCurrency = new Map(valid.map((item) => [item.key, engineItemCurrency(item, contractCurrency)]));
	const multicurrency = contract.multicurrency === true || [...lineCurrency.values()].some((code) => code !== contractCurrency);
	const missing = new MissingRates();

	if (multicurrency) {
		const spotPairs = [...new Set(lineCurrency.values())].filter((code) => code !== currency);

		if (contract.fx_invoice_policy !== 'fixed' && spotPairs.length) {
			warn(`Se factura en ${currency}: las líneas en ${spotPairs.join(', ')} se valorizan al emitir con el tipo de cambio del día de cada par`);
		}
	} else if (fx === null && !fixedFx) {
		warn(`Se factura en ${currency} y el contrato está en ${contractCurrency}: los montos están en ${contractCurrency} y se valorizan al emitir`);
	}
	if (!contract.payment_terms) {
		if (normalizeCountry(contract.company.country) === 'MX') warn('Sin condiciones de pago: vencimiento al mes siguiente de la emisión (México)');
		else warn('Sin condiciones de pago: vencimiento a 30 días');
	}

	// Cuotas por ítem, con redondeo por cuota y residuo en la última.
	const lines: EngineLine[] = [];
	const itemTotals: PreviewItemTotals[] = [];
	let contractValue = 0;

	for (const item of valid) {
		const quantity = Number(item.quantity);
		const unit = Number(item.unit_price) || 0;
		const pricing = itemPricing(item);
		const target = item.final_price !== null && item.final_price !== undefined ? round2(Number(item.final_price)) : pricing.final_price;
		const pct = pricing.discount_pct;
		const frequency = BILLING_FREQUENCY_MONTHS[item.billing_frequency as BillingFrequency] ?? 1;
		const onProrated = (start: string, end: string) => {
			flag(PRORATED_PERIOD_CODE);
			warn(prorationWarning(item, start, end));
		};

		if (!isStandardFixed(item.price)) {
			const value = pricedLines(item, anchor, taxRate, warn, lines, onProrated);

			contractValue += value;
			itemTotals.push({
				item_key: item.key,
				product_name: item.product_name,
				is_recurring: item.is_recurring,
				monthly_equivalent: item.is_recurring
					? round2(
							pricedMonthlyEquivalent(
								item.price!,
								item,
								pricedDiscountPct(item, () => undefined)
							)
						)
					: 0,
				value: round2(value),
			});
			continue;
		}

		contractValue += target;
		itemTotals.push({
			item_key: item.key,
			product_name: item.product_name,
			is_recurring: item.is_recurring,
			monthly_equivalent: item.is_recurring ? round2(quantity * unit * (1 - pct / 100)) : 0,
			value: target,
		});

		let installments: Installment[];

		if (item.is_recurring) {
			installments = recurringInstallments(item, anchor, quantity * unit * (1 - pct / 100));
		} else {
			const end = itemEffectiveEnd(item);

			installments = [
				{
					item,
					issue_date: item.start_date,
					period_start: item.start_date,
					period_end: end,
					months: Number(item.term_months) || 0,
					amount: target,
				},
			];
		}

		let accumulated = 0;

		installments.forEach((installment, position) => {
			const last = position === installments.length - 1;
			const subtotal = last ? round2(target - accumulated) : round2(installment.amount);
			const prorated = item.is_recurring && isPartialPeriod(installment.months, frequency);

			if (prorated) onProrated(installment.period_start, installment.period_end);

			if (last && Math.abs(subtotal - round2(installment.amount)) >= 1) {
				warn(`El último período de "${item.product_name}" se ajustó para que las cuotas sumen el valor del ítem`);
			}
			accumulated = round2(accumulated + subtotal);
			const taxAmount = round2((subtotal * taxRate) / 100);

			lines.push({
				issue_date: installment.issue_date,
				item_key: item.key,
				product_name: item.product_name,
				description: '',
				desc: {
					line_kind: 'standard',
					product_name: item.product_name,
					account: item.account ?? null,
					period_start: installment.period_start,
					period_end: installment.period_end,
					quantity,
					quantity_final: true,
					unit_price: round6(unit * installment.months),
					amount: subtotal,
				},
				quantity,
				unit_price: round6(unit * installment.months),
				discount_pct: round6(pct),
				subtotal,
				tax_amount: taxAmount,
				total: round2(subtotal + taxAmount),
				billing_period_start: installment.period_start,
				billing_period_end: installment.period_end,
				quantity_source: 'fixed',
				...(prorated ? { prorated: true, prorated_days: periodDays(installment.period_start, installment.period_end) } : {}),
			});
		});
	}

	// Multimoneda: el valor y el mensual de cada ítem pasan a moneda de contrato con la tasa fija pactada ítem → contrato (su inicio).
	if (multicurrency) {
		contractValue = 0;
		for (const totals of itemTotals) {
			const item = valid.find((row) => row.key === totals.item_key)!;
			const code = lineCurrency.get(totals.item_key)!;
			const rate = itemToContractRate(contract.fixed_item_rates, code, contractCurrency, item.start_date);

			if (rate === null) missing.add('item', code, contractCurrency, item.start_date);
			totals.currency = code;
			totals.item_fx_rate = rate;
			totals.monthly_equivalent_item_currency = totals.monthly_equivalent;
			totals.value_item_currency = totals.value;
			totals.monthly_equivalent = rate === null ? 0 : round2(totals.monthly_equivalent * rate);
			totals.value = rate === null ? 0 : round2(totals.value * rate);
			contractValue += totals.value;
		}
	}

	// Agrupación
	const together = contract.group_invoices_by_period !== false;
	const groups = new Map<string, typeof lines>();

	for (const line of lines) {
		const groupKey = together ? line.issue_date : `${line.issue_date}|${line.item_key}`;

		groups.set(groupKey, [...(groups.get(groupKey) ?? []), line]);
	}

	const keyOrder = new Map(valid.map((item, position) => [item.key, position]));
	let fittedLines = 0;
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
				// eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-vars -- se descartan la fecha interna de agrupación y los datos de la glosa
				lines: sorted.map(({ issue_date: _issueDate, desc: _desc, ...line }) => line),
				subtotal,
				tax,
				total: round2(subtotal + tax),
			};

			if (multicurrency) {
				invoice.lines.forEach((line) => {
					line.currency = lineCurrency.get(line.item_key) ?? contractCurrency;
				});
				const valuation = valuateMulticurrencyLines(
					invoice.lines as Array<PreviewLine & { currency: string }>,
					{
						contract_currency: contractCurrency,
						invoice_currency: currency,
						fx_invoice_policy: contract.fx_invoice_policy,
						fixed_invoice_rates: contract.fixed_invoice_rates,
						fixed_item_rates: contract.fixed_item_rates,
						tax_rate: taxRate,
					},
					(purpose, from, to, periodStart) => missing.add(purpose, from, to, periodStart)
				);

				invoice.subtotal = valuation.subtotal;
				invoice.tax = valuation.tax;
				invoice.total = valuation.total;
				invoice.fx = valuation.fx;
				if (valuation.amounts_invoice_currency) invoice.amounts_invoice_currency = valuation.amounts_invoice_currency;
			} else if (fixedFx) {
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
			// Glosa con la plantilla del contrato (o la de hoy), ya con el tipo de cambio de la factura, ajustada al límite del documento.
			invoice.lines.forEach((line, index) => {
				const fitted = fitDescription(
					contract.description_template ?? null,
					{
						...sorted[index].desc,
						// Multimoneda: el bloque de tipo de cambio de la glosa toma el par y la tasa de la línea (spec §4 "Glosa").
						contract_currency: multicurrency ? (line.currency ?? contractCurrency) : contractCurrency,
						invoice_currency: currency,
						fx_rate: multicurrency ? (line.fx ?? null) : invoice.fx,
						contract_number: contract.description_context?.contract_number ?? null,
						client_name: contract.description_context?.client_name ?? null,
					},
					contract.description_max_chars ?? null
				);

				line.description = fitted.text;
				if (fitted.fitted) fittedLines++;
			});

			return invoice;
		})
		.sort(
			(a, b) =>
				a.issue_date.localeCompare(b.issue_date) ||
				(keyOrder.get(a.lines[0].item_key) ?? 0) - (keyOrder.get(b.lines[0].item_key) ?? 0) ||
				a.billing_period_start.localeCompare(b.billing_period_start)
		);

	if (fittedLines) {
		flag(DESCRIPTION_FITTED_CODE);
		warn(descriptionFittedWarning(fittedLines, contract.description_max_chars ?? null));
	}
	const fxMissing = missing.list();

	for (const row of fxMissing) {
		warn(
			row.purpose === 'invoice'
				? `Tipo de cambio fijo: no hay tasa ${row.from_currency} → ${row.to_currency} para el período que empieza el ${formatDate(row.period_start)}`
				: `Falta la tasa pactada ${row.from_currency} → ${row.to_currency} (métricas) desde el ${formatDate(row.period_start)}: esos ítems no suman a los totales en ${row.to_currency}`
		);
	}
	const invoicedTotal = round2(invoices.reduce((sum, invoice) => sum + invoice.subtotal, 0));
	const total = round2(contractValue);

	return {
		invoices,
		totals: {
			contract_value: total,
			invoiced_total: invoicedTotal,
			difference: round2(invoicedTotal - total),
			mrr: round2(itemTotals.reduce((sum, item) => sum + item.monthly_equivalent, 0)),
		},
		items: itemTotals,
		warnings,
		warning_codes: warningCodes,
		indefinite_until: indefiniteUntil,
		description_fitted_lines: fittedLines,
		...(multicurrency ? { fx_missing: fxMissing } : {}),
	};
}
