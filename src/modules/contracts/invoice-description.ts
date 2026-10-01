import { type FieldError } from '@/core/utils/validation-errors';

import { asciiGlosa, type PricedSubline, pricingGlosa } from './pricing-engine';

/**
 * Constructor de descripción de las líneas de factura (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.6, etapa 3). Pieza
 * **pura**: no lee ni escribe la base. La usan el generador v2 (`billing-engine.ts`, al generar las Por Emitir) y el servicio del 360
 * (`contract-invoice-descriptions.service.ts`, vista previa y regeneración de líneas existentes).
 *
 * Una plantilla es una lista ordenada de **bloques** unidos por un separador (` - ` por defecto). Cada bloque de datos puede llevar
 * una etiqueta (`text`, ej. "Periodo", "Cuenta", "OC") que se antepone a su valor; el bloque `text` es texto libre. Los bloques
 * vacíos (sin dato) se omiten sin dejar separadores colgando.
 *
 * `DEFAULT_TEMPLATE` reproduce **exactamente** la glosa del generador de hoy (`lineDescription`, `describeSingleLine` y la fila por
 * tramo `asciiGlosa(base - etiqueta)`), incluida su normalización: por eso un contrato sin plantilla propia no cambia ninguna glosa.
 */

export const DESCRIPTION_BLOCK_TYPES = [
	'product',
	'account',
	'period',
	'tier',
	'quantity',
	'unit_price',
	'amount',
	'fx_rate',
	'invoice_currency',
	'contract_number',
	'references',
	'client',
	'text',
] as const;
export type DescriptionBlockType = (typeof DESCRIPTION_BLOCK_TYPES)[number];

export const PERIOD_FORMATS = ['range_slash', 'month_year', 'mmm_yy', 'range_dash'] as const;
export type PeriodFormat = (typeof PERIOD_FORMATS)[number];

/**
 * Formatos por tipo de bloque (el primero es el default):
 * - `account`: `block` (bloque propio) · `inline` (pegado al bloque anterior con un espacio, como la glosa de hoy: "PRODUCTO Cuenta X").
 * - `period`: `range_slash` "01/09/2026 a 30/09/2026" · `month_year` "septiembre 2026" · `mmm_yy` "sep-26" · `range_dash` "01-09-26 al 30-09-26".
 * - `tier`: `label` (etiqueta de la fila por tramo; vacío en una línea única) · `detail` (además, en una línea única con modelo de precio,
 *   el detalle compacto "Tramos: …" de hoy).
 */
export const DESCRIPTION_BLOCK_FORMATS: Record<DescriptionBlockType, readonly string[]> = {
	product: [],
	account: ['block', 'inline'],
	period: PERIOD_FORMATS,
	tier: ['label', 'detail'],
	quantity: [],
	unit_price: [],
	amount: [],
	fx_rate: [],
	invoice_currency: [],
	contract_number: [],
	references: [],
	client: [],
	text: [],
};

export interface DescriptionBlock {
	type: DescriptionBlockType;
	format?: string;
	/** Bloque `text`: el texto libre (obligatorio). Bloques de datos: etiqueta opcional que se antepone al valor ("Periodo", "OC"). */
	text?: string;
}

export interface DescriptionTemplate {
	/** Separador entre bloques; default ` - ` (solo guion ASCII, regla de la glosa del DTE). */
	separator?: string;
	blocks: DescriptionBlock[];
}

export const DEFAULT_SEPARATOR = ' - ';
export const TEMPLATE_MAX_BLOCKS = 12;
export const TEMPLATE_TEXT_MAX = 120;
export const TEMPLATE_SEPARATOR_MAX = 10;

/** La glosa de hoy: `PRODUCTO Cuenta X - Periodo dd/mm/aaaa a dd/mm/aaaa` (+ ` - etiqueta del tramo` o ` - Tramos: …`). */
export const DEFAULT_TEMPLATE: DescriptionTemplate = Object.freeze({
	separator: DEFAULT_SEPARATOR,
	blocks: Object.freeze([
		Object.freeze({ type: 'product' }),
		Object.freeze({ type: 'account', format: 'inline', text: 'Cuenta' }),
		Object.freeze({ type: 'period', format: 'range_slash', text: 'Periodo' }),
		Object.freeze({ type: 'tier', format: 'detail' }),
	]) as DescriptionBlock[],
}) as DescriptionTemplate;

/** Cómo se factura la línea: estándar (sin modelo de precio), una línea con modelo de precio, o una fila de un precio `per_tier`. */
export type DescriptionLineKind = 'standard' | 'single' | 'per_tier';

export interface DescriptionReference {
	/** `OC`, `HES` o el nombre/código del documento referenciado. */
	kind: string;
	code: string;
}

/** Datos de UNA línea para renderizar su descripción. Todo opcional salvo el tipo de línea: un dato ausente deja su bloque vacío. */
export interface DescriptionContext {
	line_kind: DescriptionLineKind;
	product_name?: string | null;
	account?: string | null;
	period_start?: string | null;
	period_end?: string | null;
	/** Fila `per_tier`: etiqueta del tramo/paquete/ajuste ("Tramo 1 (1-500)"). */
	tier_label?: string | null;
	/** Línea `single` con modelo de precio: sublíneas del desglose (para el detalle "Tramos: …"). */
	breakdown?: Array<Pick<PricedSubline, 'kind' | 'quantity' | 'amount' | 'label'> & Partial<PricedSubline>> | null;
	quantity?: number | null;
	unit?: string | null;
	/** `false` cuando la cantidad todavía no es la final (línea medida sin consumo cerrado: `quantity_source` pending/estimated). */
	quantity_final?: boolean;
	unit_price?: number | null;
	/** Subtotal de la línea en moneda de contrato. */
	amount?: number | null;
	contract_currency?: string | null;
	invoice_currency?: string | null;
	/** Tasa 1 moneda de contrato = X moneda de factura; null en spot sin tasa. */
	fx_rate?: number | null;
	contract_number?: string | null;
	references?: DescriptionReference[] | null;
	client_name?: string | null;
}

export type PendingField = 'quantity' | 'unit_price' | 'amount' | 'fx_rate' | 'references';

export interface RenderedDescription {
	text: string;
	length: number;
	/** Datos dinámicos que aún no son finales (se completan al emitir): el bloque va con el valor actual/estimado o se omite. */
	pending_fields: PendingField[];
}

// ------------------------------------------------------------------ formato

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const pad = (value: number) => String(value).padStart(2, '0');
const parseIso = (iso: string) => {
	const [y, m, d] = iso.slice(0, 10).split('-').map(Number);

	return { y, m, d };
};
const isIsoDate = (value: string | null | undefined): value is string => !!value && /^\d{4}-\d{2}-\d{2}/.test(value);
const slashDate = (iso: string) => {
	const { y, m, d } = parseIso(iso);

	return `${pad(d)}/${pad(m)}/${y}`;
};
const dashDate = (iso: string) => {
	const { y, m, d } = parseIso(iso);

	return `${pad(d)}-${pad(m)}-${pad(y % 100)}`;
};
const monthYear = (iso: string) => {
	const { y, m } = parseIso(iso);

	return `${MONTHS[m - 1]} ${y}`;
};
const shortMonth = (iso: string) => {
	const { y, m } = parseIso(iso);

	return `${MONTHS_SHORT[m - 1]}-${pad(y % 100)}`;
};

/** Período en el formato del bloque. `month_year`/`mmm_yy` de un período de varios meses: "septiembre a noviembre 2026" / "sep-26 a nov-26". */
export function formatPeriod(start: string | null | undefined, end: string | null | undefined, format: string | undefined): string {
	if (!isIsoDate(start)) return '';
	const until = isIsoDate(end) ? end : start;
	const sameMonth = start.slice(0, 7) === until.slice(0, 7);

	switch (format) {
		case 'month_year': {
			if (sameMonth) return monthYear(start);
			const a = parseIso(start);
			const b = parseIso(until);

			return a.y === b.y ? `${MONTHS[a.m - 1]} a ${monthYear(until)}` : `${monthYear(start)} a ${monthYear(until)}`;
		}
		case 'mmm_yy':
			return sameMonth ? shortMonth(start) : `${shortMonth(start)} a ${shortMonth(until)}`;
		case 'range_dash':
			return `${dashDate(start)} al ${dashDate(until)}`;
		default:
			return `${slashDate(start)} a ${slashDate(until)}`;
	}
}

const fmtNumber = (value: number, min: number, max: number) =>
	value.toLocaleString('es-CL', { minimumFractionDigits: min, maximumFractionDigits: max });
const present = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
/** Normalización de la glosa de hoy (`lineDescription`): solo guion ASCII y espacios simples. */
const legacyText = (text: string) =>
	text
		.replace(/[‒–—―−]/g, '-')
		.replace(/\s+/g, ' ')
		.trim();
const withLabel = (label: string | undefined, value: string) => {
	const clean = asciiGlosa(label ?? '');

	return value ? (clean ? `${clean} ${value}` : value) : '';
};
const upper = (value: string | null | undefined) => (value ?? '').trim().toUpperCase();
const isMultiCurrency = (context: DescriptionContext) =>
	!!upper(context.invoice_currency) && !!upper(context.contract_currency) && upper(context.invoice_currency) !== upper(context.contract_currency);

/** Kind de una referencia a partir del código SII guardado (`801` = OC, `HES`), o el nombre/código tal cual. */
export function referenceKind(code: string | null | undefined, name?: string | null): string {
	const clean = (code ?? '').trim().toUpperCase();

	if (clean === '801' || clean === 'OC') return 'OC';
	if (clean === 'HES') return 'HES';

	return (name ?? '').trim() || clean || 'Ref';
}

/**
 * Etiqueta de una fila `per_tier` guardada a partir de su `pricing_breakdown` (el motor no guarda la etiqueta aparte): la sublínea
 * propia de la fila es la última (las gratis viajan delante en la primera fila); sin cargos ni ajustes, la de la primera gratis o
 * "Sin consumo tarifado" (misma regla que `splitInvoiceLines`).
 */
export function tierLabelFromBreakdown(rows: Array<Partial<PricedSubline>> | null | undefined): string | null {
	// El descuento puntual de la factura (sublínea `one_off`, spec §3.4) no es un tramo.
	rows = Array.isArray(rows) ? rows.filter((row) => row.one_off !== true) : rows;
	if (!Array.isArray(rows) || !rows.length) return null;
	const charge = new Set(['tier', 'package', 'seat']);
	const selected = rows.filter(
		(row) =>
			(charge.has(String(row.kind)) && (Number(row.quantity) > 0 || Number(row.amount) !== 0)) ||
			(!charge.has(String(row.kind)) && row.kind !== 'free' && Number(row.amount) !== 0)
	);

	if (!selected.length) return rows.find((row) => row.kind === 'free')?.label ?? 'Sin consumo tarifado';

	return selected[selected.length - 1].label ?? null;
}

/** ¿Es una fila de un precio `per_tier`? El motor decora sus sublíneas con `line_index`/`line_count`. */
export const isPerTierBreakdown = (rows: Array<Partial<PricedSubline>> | null | undefined): boolean =>
	Array.isArray(rows) && rows.some((row) => row.line_index !== undefined && row.line_index !== null);

// ------------------------------------------------------------------ render

interface RenderedBlock {
	value: string;
	/** El detalle de precio ya es ASCII y se pega tal cual (como `describeSingleLine`). */
	raw?: boolean;
	inline?: boolean;
}

function renderBlock(block: DescriptionBlock, context: DescriptionContext, pending: Set<PendingField>): RenderedBlock {
	const quantityOpen = context.quantity_final === false;

	switch (block.type) {
		case 'product':
			return { value: withLabel(block.text, legacyText(context.product_name ?? '')) };
		case 'account': {
			const account = legacyText(context.account ?? '');

			return { value: withLabel(block.text, account), inline: block.format === 'inline' };
		}
		case 'period':
			return { value: withLabel(block.text, formatPeriod(context.period_start, context.period_end, block.format)) };
		case 'tier': {
			if (context.line_kind === 'per_tier') return { value: withLabel(block.text, legacyText(context.tier_label ?? '')) };
			if (context.line_kind === 'single' && block.format === 'detail' && context.breakdown?.length) {
				return { value: withLabel(block.text, pricingGlosa({ breakdown: context.breakdown as PricedSubline[] })), raw: true };
			}

			return { value: '' };
		}
		case 'quantity': {
			if (!present(context.quantity)) return { value: '' };
			if (quantityOpen) pending.add('quantity');
			const unit = legacyText(context.unit ?? '');

			return { value: withLabel(block.text, `${fmtNumber(context.quantity, 0, 6)}${unit ? ` ${unit}` : ''}`) };
		}
		case 'unit_price': {
			if (!present(context.unit_price)) return { value: '' };
			if (quantityOpen) pending.add('unit_price');

			return { value: withLabel(block.text, `${fmtNumber(context.unit_price, 2, 6)} ${upper(context.contract_currency)}`.trim()) };
		}
		case 'amount': {
			if (!present(context.amount)) return { value: '' };
			if (quantityOpen) pending.add('amount');

			return { value: withLabel(block.text, `${fmtNumber(context.amount, 2, 2)} ${upper(context.contract_currency)}`.trim()) };
		}
		case 'fx_rate': {
			if (!isMultiCurrency(context)) return { value: '' };
			if (!present(context.fx_rate)) {
				pending.add('fx_rate');

				return { value: '' };
			}

			return { value: withLabel(block.text, fmtNumber(context.fx_rate, 0, 6)) };
		}
		case 'invoice_currency':
			return { value: withLabel(block.text, upper(context.invoice_currency || context.contract_currency)) };
		case 'contract_number':
			return { value: withLabel(block.text, legacyText(context.contract_number ?? '')) };
		case 'references': {
			const refs = (context.references ?? []).filter((ref) => ref.code?.trim());

			if (!refs.length) {
				pending.add('references');

				return { value: '' };
			}

			return { value: withLabel(block.text, asciiGlosa(refs.map((ref) => `${ref.kind} ${ref.code.trim()}`).join(', '))) };
		}
		case 'client':
			return { value: withLabel(block.text, legacyText(context.client_name ?? '')) };
		case 'text':
			return { value: asciiGlosa(block.text ?? '') };
		default:
			return { value: '' };
	}
}

/** Valor final de cada bloque renderizado (índice del bloque en la plantilla), antes de unirlos. */
interface RenderedPart {
	index: number;
	type: DescriptionBlockType;
	value: string;
	inline: boolean;
}

function renderParts(
	template: DescriptionTemplate,
	context: DescriptionContext,
	pending: Set<PendingField>,
	overrides?: ReadonlyMap<number, string>
): RenderedPart[] {
	const parts: RenderedPart[] = [];

	(template.blocks ?? []).forEach((block, index) => {
		const rendered = renderBlock(block, context, pending);
		const normalized = rendered.raw ? rendered.value.trim() : rendered.value.replace(/\s+/g, ' ').trim();
		const value = overrides?.has(index) ? overrides.get(index)! : normalized;

		if (value) parts.push({ index, type: block.type, value, inline: rendered.inline === true });
	});

	return parts;
}

function joinParts(parts: RenderedPart[], separator: string, context: DescriptionContext): string {
	const chunks: string[] = [];

	for (const part of parts) {
		if (part.inline && chunks.length) chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${part.value}`;
		else chunks.push(part.value);
	}
	const text = chunks.join(separator);

	return context.line_kind === 'per_tier' ? asciiGlosa(text) : text.trim();
}

function renderWith(
	template: DescriptionTemplate | null | undefined,
	context: DescriptionContext,
	overrides?: ReadonlyMap<number, string>
): RenderedDescription & { parts: RenderedPart[] } {
	const effective = template ?? DEFAULT_TEMPLATE;
	const pending = new Set<PendingField>();
	const parts = renderParts(effective, context, pending, overrides);
	const text = joinParts(parts, effective.separator ?? DEFAULT_SEPARATOR, context);

	return { text, length: text.length, pending_fields: DESCRIPTION_PENDING_ORDER.filter((field) => pending.has(field)), parts };
}

/**
 * Descripción de una línea con la plantilla (null → `DEFAULT_TEMPLATE`). Bloques vacíos se omiten; `account` en formato `inline` se
 * pega al bloque anterior con un espacio. Normalización como hoy: guion ASCII y espacios simples por bloque; una fila `per_tier` pasa
 * además completa por `asciiGlosa` (como `asciiGlosa(base - etiqueta)` del motor).
 */
export function renderDescription(template: DescriptionTemplate | null | undefined, context: DescriptionContext): RenderedDescription {
	const { text, length, pending_fields } = renderWith(template, context);

	return { text, length, pending_fields };
}

const DESCRIPTION_PENDING_ORDER: PendingField[] = ['quantity', 'unit_price', 'amount', 'fx_rate', 'references'];

// ------------------------------------------------------------------ validación y límite

/**
 * Valida una plantilla: tipos y formatos conocidos, al menos un bloque, máximo `TEMPLATE_MAX_BLOCKS`, texto ≤ `TEMPLATE_TEXT_MAX`, el
 * bloque `text` con texto y separador ≤ `TEMPLATE_SEPARATOR_MAX`. Errores `[{ field: 'template.blocks.N.campo', message }]`.
 */
export function validateTemplate(template: unknown, field = 'template'): FieldError[] {
	const errors: FieldError[] = [];

	if (!template || typeof template !== 'object') return [{ field, message: 'La plantilla debe ser un objeto con bloques' }];
	const { separator, blocks } = template as { separator?: unknown; blocks?: unknown };

	if (separator !== undefined && separator !== null) {
		if (typeof separator !== 'string') errors.push({ field: `${field}.separator`, message: 'El separador debe ser texto' });
		else if (separator.length > TEMPLATE_SEPARATOR_MAX)
			errors.push({ field: `${field}.separator`, message: `El separador no puede superar ${TEMPLATE_SEPARATOR_MAX} caracteres` });
	}
	if (!Array.isArray(blocks) || blocks.length === 0) {
		errors.push({ field: `${field}.blocks`, message: 'La plantilla necesita al menos un bloque' });

		return errors;
	}
	if (blocks.length > TEMPLATE_MAX_BLOCKS) {
		errors.push({ field: `${field}.blocks`, message: `La plantilla admite hasta ${TEMPLATE_MAX_BLOCKS} bloques` });
	}
	blocks.forEach((raw: unknown, index) => {
		const path = `${field}.blocks.${index}`;
		const block = (raw ?? {}) as { type?: unknown; format?: unknown; text?: unknown };

		if (typeof block.type !== 'string' || !(DESCRIPTION_BLOCK_TYPES as readonly string[]).includes(block.type)) {
			errors.push({ field: `${path}.type`, message: `Tipo de bloque desconocido: ${String(block.type ?? '')}` });

			return;
		}
		const formats = DESCRIPTION_BLOCK_FORMATS[block.type as DescriptionBlockType];

		if (block.format !== undefined && block.format !== null && block.format !== '' && !formats.includes(String(block.format))) {
			errors.push({
				field: `${path}.format`,
				message: formats.length ? `Formato inválido para ${block.type}: ${formats.join(', ')}` : `El bloque ${block.type} no tiene formatos`,
			});
		}
		if (block.text !== undefined && block.text !== null) {
			if (typeof block.text !== 'string') errors.push({ field: `${path}.text`, message: 'El texto debe ser texto' });
			else if (block.text.length > TEMPLATE_TEXT_MAX)
				errors.push({ field: `${path}.text`, message: `El texto no puede superar ${TEMPLATE_TEXT_MAX} caracteres` });
		}
		if (block.type === 'text' && (typeof block.text !== 'string' || !block.text.trim())) {
			errors.push({ field: `${path}.text`, message: 'El bloque de texto libre necesita un texto' });
		}
	});

	return errors;
}

/** Copia limpia de una plantilla válida (solo los campos conocidos; sin `format`/`text` vacíos). */
export function normalizeTemplate(template: DescriptionTemplate): DescriptionTemplate {
	return {
		...(template.separator !== undefined && template.separator !== null ? { separator: template.separator } : {}),
		blocks: template.blocks.map((block) => ({
			type: block.type,
			...(block.format ? { format: block.format } : {}),
			...(typeof block.text === 'string' && block.text.trim() ? { text: block.text.trim() } : {}),
		})),
	};
}

/** Plantilla guardada en `contracts.invoice_description_template` (jsonb, puede venir como texto) o null si falta o no es válida. */
export function parseStoredTemplate(value: unknown): DescriptionTemplate | null {
	let parsed = value;

	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (!parsed || typeof parsed !== 'object') return null;

	return validateTemplate(parsed).length ? null : normalizeTemplate(parsed as DescriptionTemplate);
}

/** Límite de caracteres de la descripción del documento (`tax_document_types.description_max_chars`); null = sin límite. */
export function maxCharsFor(taxDocumentType: { description_max_chars?: number | string | null } | null | undefined): number | null {
	const value = Number(taxDocumentType?.description_max_chars);

	return taxDocumentType && taxDocumentType.description_max_chars !== null && Number.isInteger(value) && value > 0 ? value : null;
}

/** ¿El texto supera el límite? (sin límite, nunca). */
export const exceedsMax = (length: number, maxChars: number | null): boolean => maxChars !== null && length > maxChars;

// ------------------------------------------------------------------ ajuste automático al límite (decisión 30-09)

/**
 * Pasos del ajuste automático, en el orden en que se aplican, con su etiqueta para la UI ("se ajustó automáticamente: período corto,
 * sin cuenta").
 */
export const FIT_STEPS = {
	short_period: 'período corto',
	no_labels: 'sin etiquetas',
	no_account: 'sin cuenta',
	short_tier: 'tramo resumido',
	trimmed_text: 'texto libre recortado',
	hard_cut: 'texto recortado',
} as const;
export type FitStep = keyof typeof FIT_STEPS;

/** Código de advertencia estable cuando una operación generó descripciones ajustadas al límite del documento. */
export const DESCRIPTION_FITTED_CODE = 'description_fitted';

export interface FittedDescription extends RenderedDescription {
	/** `true` si el texto se ajustó para no superar el límite del documento. */
	fitted: boolean;
	/** Pasos aplicados, en español (`FIT_STEPS`), en orden. */
	steps: string[];
	step_codes: FitStep[];
}

const PERIOD_ORDER: PeriodFormat[] = ['range_slash', 'range_dash', 'month_year', 'mmm_yy'];
/** Palabra cortada: si hay un espacio en los últimos N caracteres, se corta ahí. */
const WORD_BOUNDARY_WINDOW = 8;
/** Un bloque recortado a menos de esto se omite (un "Li" no informa nada). */
const MIN_CUT_LENGTH = 4;

/** ¿El período son meses completos (del día 1 al último día de un mes)? Solo entonces se puede escribir como "sep-26". */
function wholeMonths(context: DescriptionContext): boolean {
	if (!isIsoDate(context.period_start)) return false;
	const until = isIsoDate(context.period_end) ? context.period_end : context.period_start;
	const a = parseIso(context.period_start);
	const b = parseIso(until);

	return a.d === 1 && b.d === new Date(Date.UTC(b.y, b.m, 0)).getUTCDate();
}

/** Corta `value` a `target` caracteres sin partir una palabra si hay un límite de palabra en los últimos 8; sin puntuación colgando. */
export function cutAtWord(value: string, target: number): string {
	if (value.length <= target) return value;
	if (target <= 0) return '';
	const head = value.slice(0, target);
	let cut = head;

	if (value[target] !== ' ') {
		const space = head.lastIndexOf(' ');

		if (space > 0 && head.length - space <= WORD_BOUNDARY_WINDOW) cut = head.slice(0, space);
	}

	return cut.replace(/[\s\-,;:.(/]+$/, '').trimEnd();
}

/**
 * Descripción ajustada al límite del documento (`description_max_chars`; null = sin límite). Si la glosa normal cabe, se devuelve tal
 * cual (`fitted: false`). Si no, se acorta en pasos deterministas y se detiene apenas cabe:
 * 1. período corto: `range_slash` → `range_dash` → `month_year`/`mmm_yy` (estos dos solo con meses completos);
 * 2. sin etiquetas (`text` de los bloques de datos: "Periodo", "Cuenta"), del último bloque al primero;
 * 3. sin el bloque `account`;
 * 4. bloque `tier` en formato `label` (sin el detalle "Tramos: …");
 * 5. texto libre recortado (bloques `text`, del último al primero);
 * 6. último recurso: recorte del bloque de datos más largo (se conservan período y tramo, que van al final), sin partir palabras si
 *    hay un espacio en los últimos 8 caracteres.
 * Cada paso solo se aplica si acorta el texto. El resultado nunca supera el límite.
 */
export function fitDescription(
	template: DescriptionTemplate | null | undefined,
	context: DescriptionContext,
	maxChars: number | null
): FittedDescription {
	const plain = renderWith(template, context);
	const codes: FitStep[] = [];
	const finish = (rendered: Pick<RenderedDescription, 'text' | 'pending_fields'>): FittedDescription => ({
		text: rendered.text,
		length: rendered.text.length,
		pending_fields: rendered.pending_fields,
		fitted: codes.length > 0,
		steps: codes.map((code) => FIT_STEPS[code]),
		step_codes: [...codes],
	});

	if (maxChars === null || plain.length <= maxChars) return finish(plain);
	const source = template ?? DEFAULT_TEMPLATE;
	const work: DescriptionTemplate = { separator: source.separator, blocks: (source.blocks ?? []).map((block) => ({ ...block })) };
	const overrides = new Map<number, string>();
	let current = plain;
	const fits = () => current.length <= maxChars;
	/** Aplica un cambio si acorta el texto (si no, lo revierte). Devuelve si se aplicó. */
	const attempt = (code: FitStep, mutate: () => void): boolean => {
		const blocks = work.blocks.map((block) => ({ ...block }));
		const saved = new Map(overrides);

		mutate();
		const next = renderWith(work, context, overrides);

		if (next.length >= current.length) {
			work.blocks = blocks;
			overrides.clear();
			saved.forEach((value, key) => overrides.set(key, value));

			return false;
		}
		current = next;
		if (!codes.includes(code)) codes.push(code);

		return true;
	};
	const indexes = (type: DescriptionBlockType) =>
		work.blocks.map((block, index) => (block.type === type ? index : -1)).filter((index) => index >= 0);

	// 1. período corto
	for (const index of indexes('period')) {
		const from = Math.max(0, PERIOD_ORDER.indexOf((work.blocks[index].format as PeriodFormat) ?? 'range_slash'));

		for (const format of PERIOD_ORDER.slice(from + 1)) {
			if ((format === 'month_year' || format === 'mmm_yy') && !wholeMonths(context)) continue;
			attempt('short_period', () => (work.blocks[index] = { ...work.blocks[index], format }));
			if (fits()) return finish(current);
		}
	}
	// 2. sin etiquetas (bloques de datos), del último al primero
	for (let index = work.blocks.length - 1; index >= 0; index--) {
		if (work.blocks[index].type === 'text' || !work.blocks[index].text) continue;
		attempt('no_labels', () => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-vars -- se descarta la etiqueta
			const { text: _label, ...rest } = work.blocks[index];

			work.blocks[index] = rest;
		});
		if (fits()) return finish(current);
	}
	// 3. sin cuenta
	for (const index of indexes('account').reverse()) {
		attempt('no_account', () => work.blocks.splice(index, 1));
		if (fits()) return finish(current);
	}
	// 4. tramo resumido
	for (const index of indexes('tier')) {
		if (work.blocks[index].format !== 'detail') continue;
		attempt('short_tier', () => (work.blocks[index] = { ...work.blocks[index], format: 'label' }));
		if (fits()) return finish(current);
	}
	// 5. texto libre recortado, del último al primero
	for (const index of indexes('text').reverse()) {
		const value = asciiGlosa(work.blocks[index].text ?? '');
		const target = value.length - (current.length - maxChars);
		const next = target < MIN_CUT_LENGTH ? '' : cutAtWord(value, target);

		attempt('trimmed_text', () => (work.blocks[index] = { ...work.blocks[index], text: next }));
		if (fits()) return finish(current);
	}
	// 6. último recurso: el bloque de datos más largo (período y tramo se conservan mientras haya otro que recortar)
	for (let guard = 0; guard < 50 && !fits(); guard++) {
		const parts = current.parts;
		const preferred = parts.filter((part) => part.type !== 'period' && part.type !== 'tier');
		const pool = preferred.length ? preferred : parts;

		if (!pool.length) break;
		const longest = pool.reduce((best, part) => (part.value.length > best.value.length ? part : best));
		const target = longest.value.length - (current.length - maxChars);
		const next = target < MIN_CUT_LENGTH ? '' : cutAtWord(longest.value, target);

		if (!attempt('hard_cut', () => overrides.set(longest.index, next)) && !attempt('hard_cut', () => overrides.set(longest.index, ''))) break;
	}
	if (!fits()) {
		if (!codes.includes('hard_cut')) codes.push('hard_cut');

		return finish({ text: cutAtWord(current.text, maxChars).slice(0, maxChars), pending_fields: current.pending_fields });
	}

	return finish(current);
}

/** Texto manual de una línea (`mode: 'set'`): misma normalización ASCII que la glosa. */
export const manualDescription = (text: string): string => asciiGlosa(text);

/** Plantilla ad hoc de una sola vez (`apply_blocks`) o la efectiva del contrato: la propia, si no la default. */
export const effectiveTemplate = (own: DescriptionTemplate | null | undefined): { template: DescriptionTemplate; is_default: boolean } =>
	own ? { template: own, is_default: false } : { template: DEFAULT_TEMPLATE, is_default: true };

// ------------------------------------------------------------------ plan sobre líneas existentes (PATCH …/invoices/descriptions)

export const DESCRIPTION_MODES = ['apply_template', 'apply_blocks', 'set', 'unlock'] as const;
export type DescriptionMode = (typeof DESCRIPTION_MODES)[number];

/** Una línea existente de una Por Emitir, con los datos para renderizarla. */
export interface DescriptionLineInput {
	line_id: string;
	invoice_id: string;
	description: string | null;
	locked: boolean;
	context: DescriptionContext;
	/** Código del bloqueo de su factura (not_pending, sent_to_erp_draft…): la línea no se toca. */
	blocked_reason?: string | null;
	/** Línea editada a mano en el editor de la Por Emitir (`quantity_source = manual`, spec §3.4): regenerar con plantilla la salta. */
	manual?: boolean;
	/** Línea visible del documento de una factura por OC (§3.7b): ninguna plantilla la reescribe, ni con `include_locked` (`partial_billing`). */
	po_visible?: boolean;
}

export interface DescriptionLinePlan {
	line_id: string;
	invoice_id: string;
	before: string;
	after: string;
	length: number;
	exceeds: boolean;
	/** Estado de protección DESPUÉS de aplicar (true = glosa escrita a mano). */
	locked: boolean;
	pending_fields: PendingField[];
	/** La glosa generada se ajustó automáticamente al límite del documento (nunca en `set`, el texto manual). */
	fitted: boolean;
	/** Pasos del ajuste, en español (`FIT_STEPS`); vacío si no se ajustó. */
	fit_steps: string[];
	/** `locked` (protegida, sin include_locked) · `manual_edit_kept` (línea editada a mano, sin include_locked) · `partial_billing` (visible
	 * de una factura por OC: su texto es el del documento) · `unchanged` · o el bloqueo de la factura. Sin motivo = se escribe. */
	skipped_reason?: string;
}

export interface DescriptionOperation {
	mode: DescriptionMode;
	/** Plantilla del contrato (null = la estándar): la usan apply_template y unlock. */
	contract_template: DescriptionTemplate | null;
	/** apply_blocks: la plantilla ad hoc del cuerpo. */
	template?: DescriptionTemplate | null;
	/** set: el texto manual. */
	text?: string | null;
	include_locked?: boolean;
	max_chars: number | null;
}

/**
 * Qué pasa con cada línea (spec §3.6): `set` escribe el texto y protege la línea; `unlock` la libera y la regenera con la plantilla del
 * contrato; `apply_template` / `apply_blocks` regeneran (con la del contrato o la ad hoc) y dejan la línea sin proteger, saltando las
 * protegidas salvo `include_locked`. Toda glosa regenerada pasa por `fitDescription` (nunca supera `max_chars`); `set` no se ajusta.
 * Las líneas de facturas bloqueadas y las que no cambian se informan como saltadas.
 */
export function planDescriptions(lines: DescriptionLineInput[], operation: DescriptionOperation): DescriptionLinePlan[] {
	return lines.map((line) => {
		const before = line.description ?? '';
		const skip = (reason: string): DescriptionLinePlan => ({
			line_id: line.line_id,
			invoice_id: line.invoice_id,
			before,
			after: before,
			length: before.length,
			exceeds: exceedsMax(before.length, operation.max_chars),
			locked: line.locked,
			pending_fields: [],
			fitted: false,
			fit_steps: [],
			skipped_reason: reason,
		});

		if (line.blocked_reason) return skip(line.blocked_reason);
		let after: string;
		let locked: boolean;
		let pending: PendingField[] = [];
		let fit: Pick<FittedDescription, 'fitted' | 'steps'> = { fitted: false, steps: [] };

		if (operation.mode === 'set') {
			after = manualDescription(operation.text ?? '');
			locked = true;
		} else {
			if (operation.mode !== 'unlock' && line.locked && !operation.include_locked) return skip('locked');
			// La visible de una factura por OC lleva el texto del documento: regenerar (aun con include_locked o "volver a la plantilla") la saltea.
			if (line.po_visible) return skip('partial_billing');
			// Una línea editada a mano (spec §3.4) no se regenera con plantilla salvo confirmación explícita (`include_locked`).
			if (operation.mode !== 'unlock' && line.manual && !operation.include_locked) return skip('manual_edit_kept');
			const template = operation.mode === 'apply_blocks' ? (operation.template ?? null) : operation.contract_template;
			// Glosa generada: se ajusta al límite del documento en el origen (decisión 30-09); el texto manual (`set`) no se toca.
			const rendered = fitDescription(template, line.context, operation.max_chars);

			after = rendered.text;
			pending = rendered.pending_fields;
			fit = rendered;
			locked = false;
		}
		if (after === before && locked === line.locked) return { ...skip('unchanged'), pending_fields: pending };

		return {
			line_id: line.line_id,
			invoice_id: line.invoice_id,
			before,
			after,
			length: after.length,
			exceeds: exceedsMax(after.length, operation.max_chars),
			locked,
			pending_fields: pending,
			fitted: fit.fitted,
			fit_steps: fit.steps,
		};
	});
}
