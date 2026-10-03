/**
 * Conciliación bancaria v2 · motor de sugerencias (`docs/v2-rediseno/spec-conciliacion-v2.md` §3.3, §3.4, §4): puro, sin base.
 *
 * - Normalización de texto (acentos, puntuación, sufijos legales, palabras bancarias), RUT/tax id, folios y alias del pagador.
 * - Reglas deterministas D1–D4 + difusa F1 con razones legibles (`reasons[{ code, points, detail }]`) y tres niveles: Exacta · Alta · Probable.
 * - Formas 1-a-1, 1-a-muchos (subset-sum acotado), muchos-a-1 (solo en el detalle) y parcial; diferencia con motivo sugerido.
 * - Nunca sugiere moneda distinta ni facturas de distintos clientes juntas.
 * - Validador de una conciliación (`planMatch`): bloqueos del movimiento, tipo de cambio y reparto entre movimientos (muchos-a-1).
 *
 * Montos con signo del movimiento (abono > 0). Fechas `YYYY-MM-DD` (texto). El saldo de las facturas viene de `balanceSql` (regla única).
 */
import { type BillingBlocker, SETTLEMENT_REASONS, type SettlementReason } from './billing-states';

// ---------------------------------------------------------------- catálogos

export const MOVEMENT_STATES = ['pending', 'partial', 'reconciled', 'ignored', 'debit'] as const;
export type MovementState = (typeof MOVEMENT_STATES)[number];
export const MATCH_CONFIDENCES = ['exact', 'high', 'medium'] as const;
export type MatchConfidence = (typeof MATCH_CONFIDENCES)[number];
export const MATCH_SHAPES = ['one_to_one', 'one_to_many', 'many_to_one', 'partial'] as const;
export type MatchShape = (typeof MATCH_SHAPES)[number];

/** Estados guardados en `bank_movements.status`. */
export const MOVEMENT_STATUS = { pending: 'Pendiente', reconciled: 'Conciliado', ignored: 'Ignorado' } as const;

/** Tolerancia de montos (centavos), la misma que los pagos. */
export const MATCH_EPSILON = 0.005;
/**
 * Tolerancia del tipo de cambio: |original × tasa − monto| ≤ max(0,01; 0,005 × tasa). El front manda el original redondeado a centavos
 * (`round2(monto / tasa)`): con tasas > 1 (USD → CLP a 950) ese redondeo mueve el producto hasta tasa × 0,005.
 */
export const FX_TOLERANCE = 0.01;
export const fxTolerance = (rate: number) => Math.max(FX_TOLERANCE, 0.005 * Math.abs(rate)) + 1e-9;
/** Umbral por defecto (en % del saldo) para sugerir `bank_fee`. */
export const DEFAULT_FEE_THRESHOLD_PCT = 1;
/** Tasas de retención típicas (pagos del exterior) y su tolerancia (±0,3 pp). */
export const WITHHOLDING_RATES = [0.1, 0.15, 0.2, 0.25, 0.35] as const;
export const WITHHOLDING_TOLERANCE = 0.003;
/** Topes del subset-sum: facturas por combinación (1-a-muchos) y movimientos por combinación (muchos-a-1). */
export const SUBSET_MAX_INVOICES = 6;
export const SUBSET_MAX_MOVEMENTS = 4;
export const MANY_TO_ONE_DAYS = 10;
export const MAX_SUGGESTIONS = 5;

/** Etiquetas en español de los motivos de ajuste (notas del pago y avisos). */
export const SETTLEMENT_REASON_LABELS: Record<SettlementReason, string> = {
	bank_fee: 'Comisión bancaria',
	withholding: 'Retención',
	fx_difference: 'Diferencia de cambio',
	rounding: 'Redondeo',
	other: 'Otro',
};

const TIER_RANK: Record<MatchConfidence, number> = { exact: 0, high: 1, medium: 2 };
const F1_HIGH = 85;
const F1_MEDIUM = 60;

export const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const cents = (value: number) => Math.round(value * 100);
const same = (a: number, b: number) => Math.abs(a - b) <= MATCH_EPSILON;

const dayNumber = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000;
export const daysBetween = (a: string, b: string) => Math.abs(dayNumber(a) - dayNumber(b));

// ---------------------------------------------------------------- normalización de texto

/** Sin acentos, mayúsculas, solo letras/dígitos separados por un espacio. */
export function normalizeText(value: string | null | undefined): string {
	return (value ?? '')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

/** Sufijos societarios (después de `normalizeText`: "S.A." → "S A"). */
const LEGAL_SUFFIX = /\b(S A S|S A|S P A|SPA|SAS|LTDA|LIMITADA|E I R L|EIRL|INC|LLC|GMBH|Y CIA|CIA)\b/g;

/** Palabras de la glosa bancaria que no identifican al pagador. */
export const BANKING_STOP_WORDS = new Set([
	'TRANSF',
	'TRANSFER',
	'TRANSFERENCIA',
	'TRANSFERENCIAS',
	'TRF',
	'TEF',
	'TRX',
	'ABONO',
	'ABONOS',
	'PAGO',
	'PAGOS',
	'DE',
	'DEL',
	'DESDE',
	'PARA',
	'A',
	'AL',
	'LA',
	'EL',
	'LOS',
	'LAS',
	'EN',
	'POR',
	'Y',
	'CTA',
	'CTE',
	'CUENTA',
	'CORRIENTE',
	'VISTA',
	'RUT',
	'REF',
	'REFERENCIA',
	'NRO',
	'NUM',
	'NUMERO',
	'NO',
	'N',
	'RECIBIDA',
	'RECIBIDO',
	'DEPOSITO',
	'DEPOSITOS',
	'OTROS',
	'OTRO',
	'BANCO',
	'BANCOS',
	'BCO',
	'ONLINE',
	'INTERNET',
	'ELECTRONICA',
	'ELECTRONICO',
	'VIA',
	'FACTURA',
	'FACTURAS',
	'FACT',
	'FAC',
	'F',
	'INV',
	'INVOICE',
	'FOLIO',
	'CLP',
	'USD',
	'EUR',
	'UF',
]);

/** Quita sufijos legales de un nombre ya normalizado. */
export const withoutLegalSuffix = (normalized: string) => normalized.replace(LEGAL_SUFFIX, ' ').replace(/\s+/g, ' ').trim();

/** Tokens significativos: sin sufijos legales, palabras bancarias, dígitos ni letras sueltas. */
export function significantTokens(value: string | null | undefined): string[] {
	return withoutLegalSuffix(normalizeText(stripRuts(value ?? '')))
		.split(' ')
		.filter((token) => token.length >= 2 && !/\d/.test(token) && !BANKING_STOP_WORDS.has(token));
}

/** Nombre del pagador desde la glosa: sin RUT, dígitos ni palabras bancarias; null si no queda nada. */
export function counterpartyNameOf(description: string | null | undefined): string | null {
	const tokens = significantTokens(description);

	return tokens.length ? tokens.join(' ') : null;
}

/** Clave de alias del pagador: glosa normalizada sin dígitos, primeros 4 tokens significativos. */
export function payerAliasKey(description: string | null | undefined): string | null {
	const tokens = significantTokens(description).slice(0, 4);

	return tokens.length ? tokens.join(' ') : null;
}

// ---------------------------------------------------------------- RUT / tax id

/** Dígito verificador módulo 11 de un RUT chileno (`0`–`9` o `K`). */
export function rutCheckDigit(body: string): string {
	let sum = 0;
	let factor = 2;

	for (let index = body.length - 1; index >= 0; index -= 1) {
		sum += Number(body[index]) * factor;
		factor = factor === 7 ? 2 : factor + 1;
	}
	const dv = 11 - (sum % 11);

	return dv === 11 ? '0' : dv === 10 ? 'K' : String(dv);
}

/** RUT válido (mod 11) normalizado `12345678K` (sin puntos, guion ni ceros a la izquierda) o null. */
export function normalizeRut(value: string | null | undefined): string | null {
	const compact = (value ?? '').toUpperCase().replace(/[^0-9K]/g, '');

	if (compact.length < 2) return null;
	const body = compact.slice(0, -1).replace(/^0+/, '');
	const dv = compact.slice(-1);

	if (!/^\d{6,8}$/.test(body)) return null;

	return rutCheckDigit(body) === dv ? `${body}${dv}` : null;
}

/** Tax id genérico: RUT válido normalizado si lo es; si no, alfanumérico en mayúsculas (≥ 5 caracteres) o null. */
export function normalizeTaxId(value: string | null | undefined): string | null {
	const rut = normalizeRut(value);

	if (rut) return rut;
	const compact = (value ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

	return compact.length >= 5 ? compact : null;
}

const RUT_PATTERN = /\b(\d{1,2}\.?\d{3}\.?\d{3})\s*-\s*([\dkK])\b/g;
const RUT_KEYWORD_PATTERN = /\bRUT[\s:.#]*(\d{7,9})([\dkK])?\b/gi;

/** Primer RUT válido (mod 11) dentro de un texto libre (glosa), normalizado; null si no hay. */
export function extractRut(text: string | null | undefined): string | null {
	const value = text ?? '';

	for (const match of value.matchAll(RUT_PATTERN)) {
		const rut = normalizeRut(`${match[1]}${match[2]}`);

		if (rut) return rut;
	}
	for (const match of value.matchAll(RUT_KEYWORD_PATTERN)) {
		const rut = normalizeRut(`${match[1]}${match[2] ?? ''}`);

		if (rut) return rut;
	}

	return null;
}

const stripRuts = (value: string) => value.replace(RUT_PATTERN, ' ').replace(RUT_KEYWORD_PATTERN, ' ');

// ---------------------------------------------------------------- folios

/** Parte numérica de un folio (última corrida de ≥ 3 dígitos, sin ceros a la izquierda) o null. */
export function folioNumber(invoiceNumber: string | null | undefined): string | null {
	const runs = (invoiceNumber ?? '').match(/\d+/g) ?? [];
	const last = [...runs].reverse().find((run) => run.replace(/^0+/, '').length >= 3);

	return last ? last.replace(/^0+/, '') : null;
}

export interface FolioScan {
	/** Números marcados como folio (F/FAC/FACT/FACTURA/INV/N°/NRO/FOLIO/# + dígitos). */
	marked: Set<string>;
	/** Toda corrida de 3–12 dígitos (sin ceros a la izquierda, fuera de RUT). */
	loose: Set<string>;
	/** Texto compacto (sin espacios) para buscar el folio completo (p. ej. `INV2024001`). */
	compact: string;
}

export function scanFolios(text: string | null | undefined): FolioScan {
	const value = stripRuts((text ?? '').replace(/N\s*[°º]/gi, ' NRO '));
	const normalized = normalizeText(value);
	const marked = new Set<string>();
	const loose = new Set<string>();

	for (const match of normalized.matchAll(/\b(?:F|FA|FAC|FACT|FACTURA|FACTURAS|INV|INVOICE|NRO|NUM|FOLIO|DOC)\s?(\d{3,12})\b/g)) {
		marked.add(match[1].replace(/^0+/, ''));
	}
	for (const match of normalized.matchAll(/\b(?:F|FAC|FACT|INV)(\d{3,12})\b/g)) marked.add(match[1].replace(/^0+/, ''));
	for (const match of normalized.matchAll(/\d{3,12}/g)) loose.add(match[0].replace(/^0+/, ''));

	return { marked, loose, compact: normalized.replace(/\s+/g, '') };
}

/** ¿El folio de la factura está en el texto? `full` = marcado, folio completo o número ≥ 4 dígitos; `partial` = número suelto. */
export function folioHit(invoiceNumber: string | null | undefined, scan: FolioScan): 'full' | 'partial' | null {
	const number = folioNumber(invoiceNumber);

	if (!number) return null;
	const whole = normalizeText(invoiceNumber).replace(/\s+/g, '');

	if (scan.marked.has(number)) return 'full';
	if (whole.length >= 4 && /[A-Z]/.test(whole) && scan.compact.includes(whole)) return 'full';
	if (scan.loose.has(number)) return number.length >= 4 ? 'full' : 'partial';

	return null;
}

// ---------------------------------------------------------------- similitud

/** Jaro-Winkler (0–1). */
export function jaroWinkler(a: string, b: string): number {
	if (!a.length || !b.length) return 0;
	if (a === b) return 1;
	const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
	const aMatches = new Array<boolean>(a.length).fill(false);
	const bMatches = new Array<boolean>(b.length).fill(false);
	let matches = 0;

	for (let i = 0; i < a.length; i += 1) {
		for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j += 1) {
			if (bMatches[j] || a[i] !== b[j]) continue;
			aMatches[i] = true;
			bMatches[j] = true;
			matches += 1;
			break;
		}
	}
	if (!matches) return 0;
	let transpositions = 0;
	let k = 0;

	for (let i = 0; i < a.length; i += 1) {
		if (!aMatches[i]) continue;
		while (!bMatches[k]) k += 1;
		if (a[i] !== b[k]) transpositions += 1;
		k += 1;
	}
	const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
	let prefix = 0;

	while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix += 1;

	return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Nombre del cliente (o razón social) en la glosa: `full` si todos sus tokens significativos aparecen (o casi, JW ≥ 0,92), `similar` si
 * aparece la mitad o el nombre completo se parece (JW ≥ 0,88) al pagador; null si no.
 */
export function nameMatch(names: Array<string | null | undefined>, description: string | null | undefined): 'full' | 'similar' | null {
	const words = significantTokens(description);

	if (!words.length) return null;
	let best: 'full' | 'similar' | null = null;

	for (const name of names) {
		const tokens = significantTokens(name);

		if (!tokens.length) continue;
		const found = tokens.filter((token) => words.some((word) => word === token || (token.length >= 4 && jaroWinkler(word, token) >= 0.92)));

		if (found.length === tokens.length) return 'full';
		if (found.length * 2 >= tokens.length || jaroWinkler(tokens.join(' '), words.join(' ')) >= 0.88) best = 'similar';
	}

	return best;
}

// ---------------------------------------------------------------- subset-sum acotado

/**
 * Combinaciones de 1..`maxSize` ítems cuyo monto suma `target` (centavos exactos), en el orden dado (el llamador ordena: vencimiento más
 * antiguo primero). Corta en `maxSolutions` (para saber si es única) y en un presupuesto de nodos. Solo montos > 0.
 */
export function subsetSums<T extends { amount: number }>(
	items: T[],
	target: number,
	options: { maxSize?: number; maxSolutions?: number; maxItems?: number; minSize?: number } = {}
): T[][] {
	const maxSize = options.maxSize ?? SUBSET_MAX_INVOICES;
	const maxSolutions = options.maxSolutions ?? 2;
	const minSize = options.minSize ?? 1;
	const pool = items.filter((item) => item.amount > MATCH_EPSILON).slice(0, options.maxItems ?? 24);
	const goal = cents(target);
	const solutions: T[][] = [];
	let budget = 50_000;
	const walk = (start: number, chosen: T[], sum: number) => {
		if (solutions.length >= maxSolutions || budget <= 0) return;
		budget -= 1;
		if (sum === goal && chosen.length >= minSize) {
			solutions.push([...chosen]);

			return;
		}
		if (chosen.length >= maxSize) return;
		for (let index = start; index < pool.length; index += 1) {
			const next = sum + cents(pool[index].amount);

			if (next > goal) continue;
			chosen.push(pool[index]);
			walk(index + 1, chosen, next);
			chosen.pop();
			if (solutions.length >= maxSolutions) return;
		}
	};

	if (goal > 0) walk(0, [], 0);

	return solutions;
}

// ---------------------------------------------------------------- estado del movimiento

/** Estado derivado: `ignored` > `debit` (monto ≤ 0) > `reconciled` (Conciliado) > `partial` (aplicado > 0) > `pending`. */
export function movementStateOf(row: { status: string | null; amount: number | null; applied?: number | null }): MovementState {
	if (row.status === MOVEMENT_STATUS.ignored) return 'ignored';
	if (!((row.amount ?? 0) > 0)) return 'debit';
	if (row.status === MOVEMENT_STATUS.reconciled) return 'reconciled';
	if ((row.applied ?? 0) > MATCH_EPSILON) return 'partial';

	return 'pending';
}

/** Resto por aplicar de un abono en su moneda (≥ 0). */
export const remainingOf = (row: { amount: number | null; applied?: number | null }) => Math.max(round2((row.amount ?? 0) - (row.applied ?? 0)), 0);

// ---------------------------------------------------------------- diferencia con motivo sugerido

export interface MatchDifference {
	amount: number;
	currency: string;
	suggested_reason: SettlementReason | null;
	hint: string;
}

/**
 * Diferencia cuando lo recibido no cubre el saldo y el motivo es explicable: `rounding` (≤ 1 unidad), `withholding` (≈ 10/15/20/25/35 %
 * del saldo, ±0,3 pp) o `bank_fee` (≤ `feeThresholdPct` % del saldo). Sin motivo explicable → null (la sugerencia queda parcial). Solo
 * sugerencia: nunca se aplica sin que el usuario elija el motivo.
 */
export function differenceOf(
	received: number,
	balance: number,
	currency: string,
	feeThresholdPct = DEFAULT_FEE_THRESHOLD_PCT
): MatchDifference | null {
	const amount = round2(balance - received);

	if (!(amount > MATCH_EPSILON) || !(balance > 0)) return null;
	const ratio = amount / balance;
	const rate = WITHHOLDING_RATES.find((value) => Math.abs(ratio - value) <= WITHHOLDING_TOLERANCE);
	let reason: SettlementReason | null = null;
	let hint = '';

	if (amount <= 1) {
		reason = 'rounding';
		hint = `Faltan ${amount} ${currency}: parece un redondeo`;
	} else if (rate !== undefined) {
		reason = 'withholding';
		hint = `Faltan ${amount} ${currency} (${Math.round(ratio * 1000) / 10} % del saldo): parece una retención del ${rate * 100} %`;
	} else if (ratio * 100 <= feeThresholdPct) {
		reason = 'bank_fee';
		hint = `Faltan ${amount} ${currency} (${Math.round(ratio * 1000) / 10} % del saldo): parece una comisión bancaria`;
	}

	return reason ? { amount, currency, suggested_reason: reason, hint } : null;
}

// ---------------------------------------------------------------- motor de sugerencias

export interface EngineInvoice {
	id: string;
	invoice_number: string | null;
	client_id: string | null;
	client_name: string | null;
	client_entity_name: string | null;
	tax_id: string | null;
	currency: string;
	balance: number;
	due_date: string | null;
	contract_id: string | null;
}

export interface EngineMovement {
	id: string;
	date: string;
	description: string | null;
	reference: string | null;
	amount: number;
	currency: string;
	/** Resto por aplicar (en la moneda del movimiento). */
	remaining: number;
	counterparty_tax_id: string | null;
}

export interface EngineContext {
	invoices: EngineInvoice[];
	/** Alias aprendidos: `A:<clave>` o `T:<tax id>` → cliente (null = apunta a dos clientes: no se usa). */
	aliases: Map<string, string | null>;
	/** Clientes con pagos monetarios conciliados desde cartola (pagador recurrente por el canal). */
	recurrentClients: Set<string>;
	feeThresholdPct: number;
}

export interface MatchReason {
	code: string;
	points: number;
	detail: string;
}

export interface MatchAllocation {
	invoice_id: string;
	invoice_number: string | null;
	client_id: string | null;
	client_name: string | null;
	contract_id: string | null;
	currency: string;
	balance: number;
	amount: number;
}

export interface MatchSuggestion {
	key: string;
	shape: MatchShape;
	confidence: MatchConfidence;
	score: number;
	reasons: MatchReason[];
	allocations: MatchAllocation[];
	movement_ids: string[];
	total: number;
	difference: MatchDifference | null;
}

/** Historial para alias: glosa y RUT de movimientos con pagos monetarios confirmados → cliente de la factura. */
export function learnAliases(history: Array<{ description: string | null; tax_id: string | null; client_id: string | null }>): {
	aliases: Map<string, string | null>;
	recurrentClients: Set<string>;
} {
	const aliases = new Map<string, string | null>();
	const recurrentClients = new Set<string>();
	const learn = (key: string | null, client: string) => {
		if (!key) return;
		const current = aliases.get(key);

		if (current === undefined) aliases.set(key, client);
		else if (current !== client) aliases.set(key, null);
	};

	for (const row of history) {
		if (!row.client_id) continue;
		recurrentClients.add(row.client_id);
		const alias = payerAliasKey(row.description);
		const taxId = normalizeTaxId(row.tax_id) ?? extractRut(row.description);

		learn(alias ? `A:${alias}` : null, row.client_id);
		learn(taxId ? `T:${taxId}` : null, row.client_id);
	}

	return { aliases, recurrentClients };
}

const allocationOf = (invoice: EngineInvoice, amount: number): MatchAllocation => ({
	invoice_id: invoice.id,
	invoice_number: invoice.invoice_number,
	client_id: invoice.client_id,
	client_name: invoice.client_name,
	contract_id: invoice.contract_id,
	currency: invoice.currency,
	balance: round2(invoice.balance),
	amount: round2(amount),
});

const byDue = (a: EngineInvoice, b: EngineInvoice) =>
	(a.due_date ?? '9999-12-31').localeCompare(b.due_date ?? '9999-12-31') || a.id.localeCompare(b.id);

const label = (invoice: EngineInvoice) => invoice.invoice_number ?? 'sin folio';
const labels = (invoices: EngineInvoice[]) => invoices.map(label).join(', ');

function suggestion(
	shape: MatchShape,
	confidence: MatchConfidence,
	score: number,
	reasons: MatchReason[],
	allocations: MatchAllocation[],
	movementIds: string[],
	difference: MatchDifference | null = null
): MatchSuggestion {
	const total = round2(allocations.reduce((sum, allocation) => sum + allocation.amount, 0));
	const key = `${shape}|${movementIds.join('+')}|${allocations.map((allocation) => `${allocation.invoice_id}:${allocation.amount}`).join(',')}`;

	return { key, shape, confidence, score, reasons, allocations, movement_ids: movementIds, total, difference };
}

/** Cliente identificado por alias aprendido (por RUT del historial o por glosa); null si no hay o es ambiguo. */
function aliasClientOf(movement: EngineMovement, ctx: EngineContext): { client_id: string; via: 'tax_history' | 'alias' } | null {
	const taxId = movement.counterparty_tax_id;
	const byTax = taxId ? ctx.aliases.get(`T:${taxId}`) : undefined;

	if (byTax) return { client_id: byTax, via: 'tax_history' };
	const alias = payerAliasKey(movement.description);
	const byAlias = alias ? ctx.aliases.get(`A:${alias}`) : undefined;

	return byAlias ? { client_id: byAlias, via: 'alias' } : null;
}

/** Reglas D2/D3: monto = saldo de una factura del cliente, o = Σ saldos de un subconjunto ≤ 6 (único → nivel de la regla; ambiguo → Probable). */
function identityRule(movement: EngineMovement, invoices: EngineInvoice[], target: number, identity: MatchReason, score: number): MatchSuggestion[] {
	const sorted = [...invoices].sort(byDue);
	const amountReason = (detail: string): MatchReason => ({ code: 'amount_exact', points: 35, detail });
	const singles = sorted.filter((invoice) => same(invoice.balance, target));

	if (singles.length) {
		return singles
			.slice(0, 2)
			.map((invoice) =>
				suggestion(
					'one_to_one',
					'high',
					score,
					[identity, amountReason(`Monto = saldo de ${label(invoice)}`)],
					[allocationOf(invoice, invoice.balance)],
					[movement.id]
				)
			);
	}
	const subsets = subsetSums(
		sorted.map((invoice) => ({ amount: invoice.balance, invoice })),
		target,
		{ maxSize: SUBSET_MAX_INVOICES, minSize: 2 }
	);

	if (!subsets.length) return [];
	const chosen = subsets[0].map((entry) => entry.invoice);
	const unique = subsets.length === 1;

	return [
		suggestion(
			'one_to_many',
			unique ? 'high' : 'medium',
			unique ? score : 75,
			[
				identity,
				{
					code: unique ? 'subset_sum' : 'subset_ambiguous',
					points: 35,
					detail: unique
						? `Monto = suma de los saldos de ${labels(chosen)}`
						: `Monto = suma de saldos de varias combinaciones; la más antigua: ${labels(chosen)}`,
				},
			],
			chosen.map((invoice) => allocationOf(invoice, invoice.balance)),
			[movement.id]
		),
	];
}

/** F1 difusa de una factura (0–99) con sus razones. */
function fuzzyScore(
	movement: EngineMovement,
	invoice: EngineInvoice,
	target: number,
	ctx: EngineContext,
	scan: FolioScan,
	identity: { taxClient: string | null; aliasClient: { client_id: string; via: string } | null }
): { score: number; reasons: MatchReason[]; difference: MatchDifference | null } {
	const reasons: MatchReason[] = [];
	const ratio = invoice.balance > 0 ? Math.abs(target - invoice.balance) / invoice.balance : 1;
	const difference = target < invoice.balance - MATCH_EPSILON ? differenceOf(target, invoice.balance, invoice.currency, ctx.feeThresholdPct) : null;

	if (same(target, invoice.balance)) reasons.push({ code: 'amount_exact', points: 35, detail: 'Monto = saldo' });
	else if (ratio <= 0.005) reasons.push({ code: 'amount_close', points: 30, detail: 'Monto a menos de 0,5 % del saldo' });
	else if (ratio <= 0.02 || difference) {
		reasons.push({ code: 'amount_close', points: 20, detail: difference ? difference.hint : 'Monto a menos de 2 % del saldo' });
	} else
		reasons.push({ code: 'amount_partial', points: 8, detail: target < invoice.balance ? 'Pago parcial del saldo' : 'Monto mayor que el saldo' });
	const taxMatch = !!movement.counterparty_tax_id && normalizeTaxId(invoice.tax_id) === movement.counterparty_tax_id;

	if (taxMatch) reasons.push({ code: 'tax_id_match', points: 35, detail: 'RUT del pagador = RUT de la razón social' });
	else if (identity.aliasClient && identity.aliasClient.client_id === invoice.client_id) {
		reasons.push({ code: 'alias_match', points: 30, detail: 'Pagador conocido: ya pagó facturas de este cliente' });
	} else {
		const name = nameMatch([invoice.client_name, invoice.client_entity_name], `${movement.description ?? ''} ${movement.reference ?? ''}`);

		if (name === 'full')
			reasons.push({ code: 'name_match', points: 25, detail: `Nombre del cliente en la glosa (${invoice.client_name ?? ''})`.trim() });
		else if (name === 'similar') reasons.push({ code: 'name_similar', points: 15, detail: 'Nombre parecido al del cliente' });
	}
	if (folioHit(invoice.invoice_number, scan)) reasons.push({ code: 'folio_partial', points: 15, detail: `Folio ${label(invoice)} en la glosa` });
	if (invoice.due_date) {
		const days = daysBetween(invoice.due_date, movement.date);

		if (days <= 7) reasons.push({ code: 'due_date_near', points: 10, detail: `Vence a ${days} día(s) del abono` });
		else if (days <= 30) reasons.push({ code: 'due_date_near', points: 5, detail: `Vence a ${days} días del abono` });
	}
	if (invoice.client_id && ctx.recurrentClients.has(invoice.client_id)) {
		reasons.push({ code: 'recurrent_payer', points: 5, detail: 'El cliente ya pagó por transferencia' });
	}

	return {
		score: Math.min(
			99,
			reasons.reduce((sum, reason) => sum + reason.points, 0)
		),
		reasons,
		difference,
	};
}

/** Movimientos del mismo pagador (RUT o alias), misma moneda, abonos pendientes a ±10 días: candidatos de muchos-a-1. */
export function relatedMovements(movement: EngineMovement, others: EngineMovement[]): EngineMovement[] {
	const alias = payerAliasKey(movement.description);

	return others.filter(
		(other) =>
			other.id !== movement.id &&
			other.currency === movement.currency &&
			other.remaining > MATCH_EPSILON &&
			daysBetween(other.date, movement.date) <= MANY_TO_ONE_DAYS &&
			((!!movement.counterparty_tax_id && other.counterparty_tax_id === movement.counterparty_tax_id) ||
				(!!alias && payerAliasKey(other.description) === alias))
	);
}

/**
 * Sugerencias de un abono (≤ 5, nivel y luego puntaje): D1 folio + monto = saldo (Exacta 100), D2 RUT (Alta 95), D3 alias (Alta 92),
 * D4 monto único del holding (Probable 70), F1 difusa (Alta ≥ 85, Probable ≥ 60; bajo 60 no se sugiere). Solo facturas de la moneda del
 * movimiento; nunca dos clientes en una sugerencia. `related` (solo el detalle) habilita muchos-a-1.
 */
export function suggestMatches(movement: EngineMovement, ctx: EngineContext, related: EngineMovement[] = []): MatchSuggestion[] {
	const target = round2(movement.remaining);

	if (!(target > MATCH_EPSILON) || !(movement.amount > 0)) return [];
	const pool = ctx.invoices.filter((invoice) => invoice.currency === movement.currency && invoice.balance > MATCH_EPSILON);

	if (!pool.length) return [];
	const scan = scanFolios(`${movement.description ?? ''} ${movement.reference ?? ''}`);
	const taxClients = movement.counterparty_tax_id
		? [...new Set(pool.filter((invoice) => normalizeTaxId(invoice.tax_id) === movement.counterparty_tax_id).map((invoice) => invoice.client_id))]
		: [];
	const taxClient = taxClients.length === 1 ? taxClients[0] : null;
	const aliasClient = aliasClientOf(movement, ctx);
	const out: MatchSuggestion[] = [];

	// D1: folio en la glosa/referencia y monto = saldo (o varios folios del mismo cliente que suman el monto).
	const folioInvoices = pool.filter((invoice) => folioHit(invoice.invoice_number, scan) === 'full');

	for (const invoice of folioInvoices.filter((entry) => same(entry.balance, target))) {
		out.push(
			suggestion(
				'one_to_one',
				'exact',
				100,
				[
					{ code: 'folio_match', points: 65, detail: `Folio ${label(invoice)} en la glosa` },
					{ code: 'amount_exact', points: 35, detail: 'Monto = saldo' },
				],
				[allocationOf(invoice, invoice.balance)],
				[movement.id]
			)
		);
	}
	const folioByClient = new Map<string, EngineInvoice[]>();

	for (const invoice of folioInvoices)
		folioByClient.set(invoice.client_id ?? 'none', [...(folioByClient.get(invoice.client_id ?? 'none') ?? []), invoice]);
	for (const group of folioByClient.values()) {
		if (group.length < 2) continue;
		const [subset] = subsetSums(
			[...group].sort(byDue).map((invoice) => ({ amount: invoice.balance, invoice })),
			target,
			{ minSize: 2, maxSolutions: 1 }
		);

		if (!subset) continue;
		const chosen = subset.map((entry) => entry.invoice);

		out.push(
			suggestion(
				'one_to_many',
				'exact',
				100,
				[
					{ code: 'folio_match', points: 65, detail: `Folios ${labels(chosen)} en la glosa` },
					{ code: 'subset_sum', points: 35, detail: 'Monto = suma de sus saldos' },
				],
				chosen.map((invoice) => allocationOf(invoice, invoice.balance)),
				[movement.id]
			)
		);
	}
	// D2: RUT del pagador = tax id de la razón social.
	if (taxClient) {
		out.push(
			...identityRule(
				movement,
				pool.filter((invoice) => invoice.client_id === taxClient),
				target,
				{ code: 'tax_id_match', points: 60, detail: 'RUT del pagador = RUT de la razón social' },
				95
			)
		);
	}
	// D3: alias aprendido → cliente.
	if (aliasClient && aliasClient.client_id !== taxClient) {
		out.push(
			...identityRule(
				movement,
				pool.filter((invoice) => invoice.client_id === aliasClient.client_id),
				target,
				{
					code: 'alias_match',
					points: 57,
					detail: aliasClient.via === 'tax_history' ? 'RUT del pagador ya pagó facturas de este cliente' : 'Pagador conocido por la glosa',
				},
				92
			)
		);
	}
	// D4: monto = saldo de una sola factura del holding (misma moneda), sin identidad.
	const equal = pool.filter((invoice) => same(invoice.balance, target));

	if (equal.length === 1) {
		out.push(
			suggestion(
				'one_to_one',
				'medium',
				70,
				[{ code: 'amount_unique', points: 70, detail: `Monto = saldo de ${label(equal[0])}, única factura con ese saldo` }],
				[allocationOf(equal[0], equal[0].balance)],
				[movement.id]
			)
		);
	}
	// F1: difusa por factura.
	for (const invoice of pool) {
		const { score, reasons, difference } = fuzzyScore(movement, invoice, target, ctx, scan, { taxClient, aliasClient });

		if (score < F1_MEDIUM) continue;
		const amount = Math.min(target, invoice.balance);
		const shape: MatchShape = target < invoice.balance - MATCH_EPSILON && !difference ? 'partial' : 'one_to_one';

		out.push(suggestion(shape, score >= F1_HIGH ? 'high' : 'medium', score, reasons, [allocationOf(invoice, amount)], [movement.id], difference));
	}
	// Muchos-a-1 (detalle): este abono + otros del mismo pagador suman el saldo de una factura del cliente identificado.
	const client = taxClient ?? aliasClient?.client_id ?? null;
	const others = related.length && client ? relatedMovements(movement, related) : [];

	if (others.length) {
		for (const invoice of pool.filter((entry) => entry.client_id === client).sort(byDue)) {
			const rest = round2(invoice.balance - target);

			if (!(rest > MATCH_EPSILON)) continue;
			const [subset] = subsetSums(
				others.map((other) => ({ amount: other.remaining, other })),
				rest,
				{ maxSize: SUBSET_MAX_MOVEMENTS - 1, maxSolutions: 1 }
			);

			if (!subset) continue;
			const ids = [movement.id, ...subset.map((entry) => entry.other.id)];

			out.push(
				suggestion(
					'many_to_one',
					'high',
					90,
					[
						{ code: taxClient ? 'tax_id_match' : 'alias_match', points: 55, detail: 'Mismo pagador en todos los abonos' },
						{ code: 'many_to_one', points: 35, detail: `${ids.length} abonos suman el saldo de ${label(invoice)}` },
					],
					[allocationOf(invoice, invoice.balance)],
					ids
				)
			);
		}
	}

	return rankSuggestions(out);
}

/** Deduplica por conjunto de asignaciones (se queda el mejor), ordena por nivel y puntaje y corta en 5. */
export function rankSuggestions(list: MatchSuggestion[]): MatchSuggestion[] {
	const best = new Map<string, MatchSuggestion>();
	const setKey = (entry: MatchSuggestion) =>
		`${[...entry.movement_ids].sort().join('+')}|${entry.allocations
			.map((allocation) => `${allocation.invoice_id}:${allocation.amount}`)
			.sort()
			.join(',')}`;

	for (const entry of list) {
		const key = setKey(entry);
		const current = best.get(key);

		if (
			!current ||
			TIER_RANK[entry.confidence] < TIER_RANK[current.confidence] ||
			(entry.confidence === current.confidence && entry.score > current.score)
		) {
			best.set(key, entry);
		}
	}

	return [...best.values()]
		.sort((a, b) => TIER_RANK[a.confidence] - TIER_RANK[b.confidence] || b.score - a.score || a.key.localeCompare(b.key))
		.slice(0, MAX_SUGGESTIONS);
}

// ---------------------------------------------------------------- persistencia de la mejor sugerencia

/** exact → `high` + 100; high → `high` (< 100); medium → `medium`; sin sugerencia → nulls. */
export function persistedMatch(best: MatchSuggestion | null): {
	suggested_invoice_id: string | null;
	match_confidence: 'high' | 'medium' | null;
	match_score: number | null;
} {
	if (!best) return { suggested_invoice_id: null, match_confidence: null, match_score: null };

	return {
		suggested_invoice_id: best.allocations[0]?.invoice_id ?? null,
		match_confidence: best.confidence === 'medium' ? 'medium' : 'high',
		match_score: best.confidence === 'exact' ? 100 : Math.min(best.score, 99),
	};
}

/** Nivel leído de las columnas persistidas: `high` con score ≥ 100 = exact. */
export function tierOf(matchConfidence: string | null | undefined, matchScore: number | null | undefined): MatchConfidence | 'none' {
	if (matchConfidence === 'high') return (matchScore ?? 0) >= 100 ? 'exact' : 'high';
	if (matchConfidence === 'medium') return 'medium';

	return 'none';
}

// ---------------------------------------------------------------- moneda distinta

/** Con tipo de cambio: monto en la moneda de la factura = round2(original × tasa). */
export const fxFromRate = (original: number, rate: number) => ({ original_amount: round2(original), fx_rate: rate, amount: round2(original * rate) });

/** Con monto en la moneda de la factura: tasa = monto / original. */
export const fxFromAmount = (original: number, invoiceAmount: number) => ({
	original_amount: round2(original),
	fx_rate: original > 0 ? invoiceAmount / original : 0,
	amount: round2(invoiceAmount),
});

export const fxConsistent = (original: number, rate: number, amount: number) => Math.abs(original * rate - amount) <= fxTolerance(rate);

// ---------------------------------------------------------------- validador de una conciliación

export interface MatchItemInput {
	movement_ids: string[];
	allocations: Array<{ invoice_id: string; amount: number; original_amount?: number | null }>;
	fx?: { rate: number } | null;
	adjustments?: Array<{ invoice_id: string; amount: number; reason: SettlementReason | string; note?: string | null }>;
	allow_multiple_clients?: boolean;
}

export interface MatchMovementRow {
	id: string;
	amount: number;
	currency: string;
	status: string | null;
	applied: number;
	date: string;
}

export interface MatchDistribution {
	movement_id: string;
	allocations: Array<{ invoice_id: string; amount: number; original_amount: number | null }>;
}

export interface MatchPlan {
	blockers: BillingBlocker[];
	currency: string | null;
	invoice_currency: string | null;
	fx_rate: number | null;
	/** Consumo de cada asignación en la moneda del movimiento. */
	consumption: number;
	distribution: MatchDistribution[];
	movements: Array<{
		id: string;
		amount: number;
		applied_before: number;
		applied_after: number;
		remaining_after: number;
		state_after: MovementState;
	}>;
}

/**
 * Valida una conciliación a nivel de movimientos (los bloqueos de las facturas los da `planPayments`): `movement_not_found`,
 * `movement_is_debit`, `movement_not_pending` (Ignorado o ya conciliado), `movement_currency_mixed`, `fx_required` (factura en otra moneda
 * sin tipo de cambio ni monto original), `fx_inconsistent`, `note_required` (motivo `other` sin texto), `movement_overapplied` (Σ consumo en
 * la moneda del movimiento > resto + ε) y `nothing_to_apply`. Reparte el consumo entre los movimientos en orden (muchos-a-1: un `register`
 * por movimiento con su parte). Los ajustes no consumen el movimiento.
 */
export function planMatch(item: MatchItemInput, rows: MatchMovementRow[], invoiceCurrencies: Map<string, string | null>): MatchPlan {
	const blockers: BillingBlocker[] = [];
	const byId = new Map(rows.map((row) => [row.id, row]));
	const movements = item.movement_ids.map((id) => byId.get(id)).filter((row): row is MatchMovementRow => !!row);
	const add = (code: string, message: string, next_step: string | null = null) => {
		if (!blockers.some((blocker) => blocker.code === code && blocker.message === message)) blockers.push({ code, message, next_step });
	};

	for (const id of item.movement_ids) if (!byId.has(id)) add('movement_not_found', `Movimiento ${id} no encontrado en el holding`);
	for (const row of movements) {
		const state = movementStateOf(row);

		if (state === 'debit') add('movement_is_debit', `El movimiento del ${row.date} es un cargo: no paga facturas`);
		else if (state === 'ignored') add('movement_not_pending', `El movimiento del ${row.date} está ignorado`, 'Reábrelo antes de conciliarlo');
		else if (state === 'reconciled' || remainingOf(row) <= MATCH_EPSILON) {
			add('movement_not_pending', `El movimiento del ${row.date} ya está conciliado`, 'Deshaz la conciliación para cambiarla');
		}
	}
	const currencies = [...new Set(movements.map((row) => (row.currency ?? '').toUpperCase()))];

	if (currencies.length > 1) add('movement_currency_mixed', `Los movimientos son de monedas distintas (${currencies.join(', ')})`);
	const currency = currencies[0] ?? null;
	const firstInvoice = item.allocations[0]?.invoice_id ?? item.adjustments?.[0]?.invoice_id;
	const invoiceCurrency = firstInvoice ? (((invoiceCurrencies.get(firstInvoice) ?? '') || null)?.toUpperCase() ?? null) : null;
	const crossCurrency = !!currency && !!invoiceCurrency && currency !== invoiceCurrency;
	let fxRate: number | null = null;
	const originals: number[] = [];

	if (!item.allocations.length && !(item.adjustments ?? []).length) add('nothing_to_apply', 'Indica al menos una factura o un ajuste');
	if (crossCurrency) {
		const given = item.allocations.every((allocation) => allocation.original_amount !== undefined && allocation.original_amount !== null);

		if (item.fx?.rate && item.fx.rate > 0) fxRate = item.fx.rate;
		else if (given && item.allocations.length) {
			const totalOriginal = item.allocations.reduce((sum, allocation) => sum + Number(allocation.original_amount), 0);
			const totalAmount = item.allocations.reduce((sum, allocation) => sum + allocation.amount, 0);

			fxRate = totalOriginal > 0 ? totalAmount / totalOriginal : null;
		}
		if (fxRate === null && item.allocations.length) {
			add(
				'fx_required',
				`El movimiento es en ${currency} y la factura en ${invoiceCurrency}`,
				'Ingresa el tipo de cambio o el monto en la moneda de la factura'
			);
		}
		for (const allocation of item.allocations) {
			if (fxRate === null) {
				originals.push(0);
				continue;
			}
			const original =
				allocation.original_amount !== undefined && allocation.original_amount !== null
					? round2(Number(allocation.original_amount))
					: round2(allocation.amount / fxRate);

			if (!fxConsistent(original, fxRate, allocation.amount)) {
				add(
					'fx_inconsistent',
					`Tipo de cambio inconsistente: ${original} ${currency} × ${fxRate} ≠ ${allocation.amount} ${invoiceCurrency}`,
					'Revisa el tipo de cambio o los montos'
				);
			}
			originals.push(original);
		}
	} else {
		for (const allocation of item.allocations) originals.push(round2(allocation.amount));
	}
	for (const adjustment of item.adjustments ?? []) {
		if (!(SETTLEMENT_REASONS as readonly string[]).includes(adjustment.reason))
			add('invalid_reason', `Motivo de ajuste no válido: ${adjustment.reason}`);
		if (adjustment.reason === 'other' && !(adjustment.note ?? '').trim()) {
			add('note_required', 'El motivo "Otro" requiere una explicación', 'Escribe el motivo del ajuste');
		}
	}
	const consumption = round2(originals.reduce((sum, value) => sum + value, 0));
	const available = round2(movements.reduce((sum, row) => sum + remainingOf(row), 0));

	const stateBlocked = blockers.some((blocker) => blocker.code === 'movement_not_pending' || blocker.code === 'movement_is_debit');

	if (consumption > available + MATCH_EPSILON && movements.length && !stateBlocked) {
		add(
			'movement_overapplied',
			`Se asignan ${consumption} ${currency ?? ''} y el movimiento solo tiene ${available} ${currency ?? ''} por aplicar`.replace(/\s+/g, ' '),
			'Ajusta los montos al resto del movimiento'
		);
	}
	// Reparto: cada movimiento en orden consume hasta su resto; una asignación puede partirse entre movimientos.
	const distribution: MatchDistribution[] = [];
	const queue = item.allocations.map((allocation, index) => ({
		allocation,
		original: originals[index] ?? 0,
		left: originals[index] ?? 0,
		amountLeft: allocation.amount,
	}));

	for (const [index, row] of movements.entries()) {
		let capacity = remainingOf(row);
		const entry: MatchDistribution = { movement_id: row.id, allocations: [] };
		const last = index === movements.length - 1;

		for (const part of queue) {
			if (part.left <= MATCH_EPSILON || (capacity <= MATCH_EPSILON && !last)) continue;
			const take = last ? part.left : Math.min(capacity, part.left);
			const whole = same(take, part.left);
			const amount = whole ? round2(part.amountLeft) : crossCurrency && fxRate ? round2(take * fxRate) : round2(take);

			entry.allocations.push({ invoice_id: part.allocation.invoice_id, amount, original_amount: crossCurrency ? round2(take) : null });
			part.left = round2(part.left - take);
			part.amountLeft = round2(part.amountLeft - amount);
			capacity = round2(capacity - take);
		}
		if (entry.allocations.length) distribution.push(entry);
	}
	let toConsume = consumption;
	const movementResults = movements.map((row) => {
		const take = Math.min(remainingOf(row), Math.max(toConsume, 0));
		const appliedAfter = round2(row.applied + take);
		const remainingAfter = Math.max(round2(row.amount - appliedAfter), 0);

		toConsume = round2(toConsume - take);

		return {
			id: row.id,
			amount: round2(row.amount),
			applied_before: round2(row.applied),
			applied_after: appliedAfter,
			remaining_after: remainingAfter,
			state_after: movementStateOf({
				status: remainingAfter <= MATCH_EPSILON ? MOVEMENT_STATUS.reconciled : MOVEMENT_STATUS.pending,
				amount: row.amount,
				applied: appliedAfter,
			}),
		};
	});

	return {
		blockers,
		currency,
		invoice_currency: invoiceCurrency,
		fx_rate: crossCurrency ? fxRate : null,
		consumption,
		distribution,
		movements: movementResults,
	};
}
