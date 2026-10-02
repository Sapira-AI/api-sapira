import { CATEGORY_INFO, categoryOf, DERIVED_KEYS, type MovementCategory } from './metrics-categories';
import { addMonths, type Month } from './metrics-period';

/**
 * Movimientos de MRR, retención, clientes y cohortes (spec-revenue-y-metricas §1.4–1.6, §1.8). Lógica pura: recibe líneas de MRR
 * por mes ya leídas del devengo (RSM) y del legacy, y no consulta la base.
 */

export type LineSource = 'contract' | 'subscription' | 'legacy';

/** Valor de una línea en un mes. `value` en la moneda leída (NULL = sin convertir); `valueContract` en moneda de contrato. */
export interface LineMonth {
	value: number | null;
	valueContract: number | null;
	pending: number;
	/** `momentum` explícito del mes (distinto de BOP y PENDING_RENEWAL), si lo hay. */
	momentum: string | null;
}

/**
 * Línea de MRR: un ítem de contrato (`i:`), un ítem de suscripción (`s:`) o un grupo legacy (`l:` cliente + producto + moneda + contrato
 * al que migró). Los atributos sirven para filtros, dimensiones y drill-down.
 */
export interface MrrLine {
	key: string;
	source: LineSource;
	contractId: string | null;
	contractNumber: string | null;
	itemId: string | null;
	clientId: string | null;
	clientName: string | null;
	companyId: string | null;
	companyName: string | null;
	product: string | null;
	categoria: string | null;
	renewsItemId: string | null;
	renewedByItemId: string | null;
	/** Solo legacy: contrato al que se migró (`migrated_to_contract_id`). */
	legacyContractId: string | null;
	segment: string | null;
	market: string | null;
	industry: string | null;
	country: string | null;
	itemType: string | null;
	unitOfMeasure: string | null;
	months: Map<Month, LineMonth>;
}

export interface Movement {
	period: Month;
	category: MovementCategory;
	key: string;
	amount: number;
	line: MrrLine;
}

const EPS = 0.005;
const round2 = (value: number) => Math.round(value * 100) / 100;
const isZero = (value: number) => Math.abs(value) < EPS;

/** Valor convertido de la línea en el mes (0 si no tiene fila). */
export const valueAt = (line: MrrLine, month: Month) => line.months.get(month)?.value ?? 0;
const contractValueAt = (line: MrrLine, month: Month) => line.months.get(month)?.valueContract ?? 0;

/**
 * Separa las líneas con algún mes sin convertir dentro de los meses dados (§1.3): esas no entran a ningún total ni movimiento, así el
 * waterfall sigue cuadrando, y se informan aparte.
 */
export function splitUnconverted(lines: MrrLine[], months: Month[]): { converted: MrrLine[]; unconverted: MrrLine[] } {
	const converted: MrrLine[] = [];
	const unconverted: MrrLine[] = [];

	for (const line of lines) {
		const missing = months.some((month) => {
			const cell = line.months.get(month);

			return cell !== undefined && cell.value === null;
		});

		(missing ? unconverted : converted).push(line);
	}

	return { converted, unconverted };
}

/** MRR por cliente en un mes (las líneas sin cliente se agrupan en `''`). */
export function clientTotals(lines: MrrLine[], month: Month): Map<string, number> {
	const totals = new Map<string, number>();

	for (const line of lines) {
		const value = valueAt(line, month);

		if (value !== 0) totals.set(line.clientId ?? '', (totals.get(line.clientId ?? '') ?? 0) + value);
	}

	return totals;
}

interface ClassifyOptions {
	/** `contract` = se lee en moneda de contrato: un cambio de monto de un ítem vivo no es tipo de cambio. */
	currency: 'system' | 'company' | 'contract';
}

/**
 * Clasifica los cambios de MRR de cada línea entre `month - 1` y `month` (§1.4). La suma de los movimientos es exactamente
 * cierre − inicio: cada delta de línea va a un solo movimiento.
 */
export function classifyMonth(lines: MrrLine[], month: Month, { currency }: ClassifyOptions): Movement[] {
	const prevMonth = addMonths(month, -1);
	const movements: Movement[] = [];
	const handled = new Set<string>();
	const delta = (line: MrrLine) => valueAt(line, month) - valueAt(line, prevMonth);
	const appears = (line: MrrLine) => isZero(valueAt(line, prevMonth)) && !isZero(valueAt(line, month));
	const disappears = (line: MrrLine) => !isZero(valueAt(line, prevMonth)) && isZero(valueAt(line, month));
	const push = (category: MovementCategory, key: string, amount: number, line: MrrLine) => {
		if (!isZero(amount)) movements.push({ period: month, category, key, amount: round2(amount), line });
	};
	const prevClients = clientTotals(lines, prevMonth);
	const curClients = clientTotals(lines, month);

	// 1. Renovaciones: el ítem RENEWAL que aparece + los que renueva (y sus ajustes co-terminados) que desaparecen = un solo neto (D8).
	const renewedBy = new Map<string, MrrLine[]>();
	const byItemId = new Map<string, MrrLine>();

	for (const line of lines) {
		if (line.itemId) byItemId.set(line.itemId, line);
		if (line.renewedByItemId) renewedBy.set(line.renewedByItemId, [...(renewedBy.get(line.renewedByItemId) ?? []), line]);
	}
	for (const line of lines) {
		if (!line.itemId || !appears(line)) continue;
		const renewed = line.renewsItemId ? byItemId.get(line.renewsItemId) : undefined;
		const linked = new Set([...(renewedBy.get(line.itemId) ?? []), ...(renewed ? [renewed] : [])]);

		if (!linked.size) continue;
		const predecessors = [...linked].filter((item) => !handled.has(item.key) && !isZero(delta(item)));
		const members = [line, ...predecessors];
		const net = members.reduce((sum, item) => sum + delta(item), 0);

		for (const item of members) handled.add(item.key);
		push(categoryOf('RENEWAL', net), 'RENEWAL', net, line);
	}

	// 2. Legacy → su contrato (D2): no es movimiento; solo la diferencia real en moneda de contrato es expansión/contracción y el resto, FX.
	const legacyByContract = new Map<string, MrrLine[]>();

	for (const line of lines) {
		if (line.source === 'legacy' && line.legacyContractId && disappears(line) && !handled.has(line.key)) {
			legacyByContract.set(line.legacyContractId, [...(legacyByContract.get(line.legacyContractId) ?? []), line]);
		}
	}
	for (const [contractId, legacy] of legacyByContract) {
		const contractLines = lines.filter(
			(line) => line.source === 'contract' && line.contractId === contractId && appears(line) && !handled.has(line.key)
		);

		if (!contractLines.length) continue;
		const members = [...legacy, ...contractLines];
		const net = members.reduce((sum, item) => sum + delta(item), 0);
		const contractNow = contractLines.reduce((sum, item) => sum + valueAt(item, month), 0);
		const contractNowCtr = contractLines.reduce((sum, item) => sum + contractValueAt(item, month), 0);
		const legacyPrevCtr = legacy.reduce((sum, item) => sum + contractValueAt(item, prevMonth), 0);
		const netCtr = contractNowCtr - legacyPrevCtr;
		const real = currency === 'contract' ? net : !isZero(netCtr) && !isZero(contractNowCtr) ? round2(netCtr * (contractNow / contractNowCtr)) : 0;

		for (const item of members) handled.add(item.key);
		push(categoryOf(DERIVED_KEYS.legacyMigration, real), DERIVED_KEYS.legacyMigration, real, contractLines[0]);
		push('fx', DERIVED_KEYS.fx, net - real, contractLines[0]);
	}

	// 3. El resto, línea por línea.
	for (const line of lines) {
		if (handled.has(line.key)) continue;
		const amount = delta(line);

		if (isZero(amount)) continue;
		const momentum = line.months.get(month)?.momentum ?? null;
		const clientId = line.clientId ?? '';

		if (appears(line)) {
			if (line.source === 'legacy') {
				push((prevClients.get(clientId) ?? 0) > EPS ? 'expansion' : 'new', DERIVED_KEYS.legacyNew, amount, line);
			} else if (line.source === 'subscription') {
				const key = momentum ?? 'NEW';

				push(categoryOf(key, amount), key, amount, line);
			} else {
				const key = momentum ?? line.categoria ?? DERIVED_KEYS.other;

				// RENEWAL sin predecesor (BOP por el trigger): MRR que entra al sistema; nuevo si el cliente no tenía MRR, si no expansión.
				if (key === 'RENEWAL') push((prevClients.get(clientId) ?? 0) > EPS ? 'expansion' : 'new', key, amount, line);
				else push(categoryOf(key, amount), key, amount, line);
			}
			continue;
		}
		if (disappears(line)) {
			if (line.source === 'legacy') {
				// D2/L1: legacy que termina sin contrato = contracción si el cliente sigue con MRR, churn si queda en 0.
				push((curClients.get(clientId) ?? 0) > EPS ? 'contraction' : 'churn', DERIVED_KEYS.legacyEnd, amount, line);
			} else if (line.source === 'subscription') {
				push('churn', 'CHURN', amount, line);
			} else {
				const key = momentum === 'CHURN' ? 'CHURN' : DERIVED_KEYS.expired;

				push(categoryOf(key, amount), key, amount, line);
			}
			continue;
		}
		// Sigue vivo con otro monto.
		if (line.source === 'legacy') push(categoryOf(DERIVED_KEYS.legacyChange, amount), DERIVED_KEYS.legacyChange, amount, line);
		else if (line.source === 'subscription')
			push(categoryOf(DERIVED_KEYS.subscriptionChange, amount), DERIVED_KEYS.subscriptionChange, amount, line);
		else if (currency === 'contract') push('other', DERIVED_KEYS.other, amount, line);
		else push('fx', DERIVED_KEYS.fx, amount, line);
	}

	return movements;
}

export interface WaterfallMovement {
	category: MovementCategory;
	key: string;
	amount: number;
	items: number;
	clients: number;
}

export interface WaterfallMonth {
	period: Month;
	opening: number;
	movements: WaterfallMovement[];
	closing: number;
	/** Cierre − inicio − Σ movimientos: 0 por construcción (se expone para tests y para el aviso de calidad). */
	check: number;
}

/** MRR total del mes. */
export const totalAt = (lines: MrrLine[], month: Month) => round2(lines.reduce((sum, line) => sum + valueAt(line, month), 0));

/** Agrupa los movimientos por categoría y subcategoría. */
export function aggregateMovements(movements: Movement[]): WaterfallMovement[] {
	const groups = new Map<string, { category: MovementCategory; key: string; amount: number; items: Set<string>; clients: Set<string> }>();

	for (const movement of movements) {
		const id = `${movement.category}|${movement.key}`;
		const group = groups.get(id) ?? { category: movement.category, key: movement.key, amount: 0, items: new Set(), clients: new Set() };

		group.amount += movement.amount;
		group.items.add(movement.line.key);
		if (movement.line.clientId) group.clients.add(movement.line.clientId);
		groups.set(id, group);
	}

	const order = Object.keys(CATEGORY_INFO);

	return [...groups.values()]
		.map((group) => ({
			category: group.category,
			key: group.key,
			amount: round2(group.amount),
			items: group.items.size,
			clients: group.clients.size,
		}))
		.filter((group) => !isZero(group.amount))
		.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || Math.abs(b.amount) - Math.abs(a.amount));
}

/** Waterfall por mes: inicio = cierre del mes anterior (se lee el mes previo al rango, nunca arranca en 0). */
export function buildWaterfall(lines: MrrLine[], months: Month[], options: ClassifyOptions): { months: WaterfallMonth[]; movements: Movement[] } {
	const all: Movement[] = [];
	const out = months.map((month) => {
		const movements = classifyMonth(lines, month, options);
		const opening = totalAt(lines, addMonths(month, -1));
		const closing = totalAt(lines, month);
		const moved = movements.reduce((sum, movement) => sum + movement.amount, 0);

		all.push(...movements);

		return { period: month, opening, movements: aggregateMovements(movements), closing, check: round2(closing - opening - moved) };
	});

	return { months: out, movements: all };
}

export interface PeriodRetention {
	opening: number;
	closing: number;
	new: number;
	expansion: number;
	reactivation: number;
	contraction: number;
	churn: number;
	fx: number;
	other: number;
}

/** Suma por categoría de un conjunto de meses del waterfall (contracción y churn quedan negativos). */
export function retentionOf(months: WaterfallMonth[]): PeriodRetention {
	const sum = (category: MovementCategory) =>
		round2(months.reduce((total, month) => total + month.movements.filter((m) => m.category === category).reduce((s, m) => s + m.amount, 0), 0));

	return {
		opening: months[0]?.opening ?? 0,
		closing: months[months.length - 1]?.closing ?? 0,
		new: sum('new'),
		expansion: sum('expansion'),
		reactivation: sum('reactivation'),
		contraction: sum('contraction'),
		churn: sum('churn'),
		fx: sum('fx'),
		other: sum('other'),
	};
}

const ratio = (num: number, den: number) => (Math.abs(den) < EPS ? null : num / den);

/** Indicadores del período (§1.5). Proporciones como fracción (0,95 = 95 %); `null` = no aplica (inicio 0 o sin pérdidas). */
export function periodIndicators(r: PeriodRetention) {
	const losses = 0 - (r.contraction + r.churn);
	const gains = r.new + r.expansion + r.reactivation;

	return {
		net_new_mrr: round2(gains - losses),
		growth: ratio(r.closing - r.opening, r.opening),
		gross_mrr_churn: ratio(losses, r.opening),
		net_mrr_churn: ratio(losses - (r.expansion + r.reactivation), r.opening),
		nrr: ratio(r.opening + r.expansion + r.reactivation + r.contraction + r.churn, r.opening),
		grr: ratio(r.opening + r.contraction + r.churn, r.opening),
		quick_ratio: ratio(gains, losses),
	};
}

/** NRR y GRR interanuales por cliente (§1.5, D6): sobre los clientes con MRR > 0 hace 12 meses. */
export function yoyRetention(lines: MrrLine[], month: Month): { nrr: number | null; grr: number | null } {
	const before = clientTotals(lines, addMonths(month, -12));
	const now = clientTotals(lines, month);
	let base = 0;
	let net = 0;
	let gross = 0;

	for (const [client, value] of before) {
		if (value <= EPS) continue;
		const current = Math.max(now.get(client) ?? 0, 0);

		base += value;
		net += current;
		gross += Math.min(current, value);
	}

	return { nrr: ratio(net, base), grr: ratio(gross, base) };
}

/** Clientes activos (MRR > 0) del mes y churn de logos (activos el mes anterior que quedan en 0). */
export function logoStats(lines: MrrLine[], month: Month) {
	const prev = clientTotals(lines, addMonths(month, -1));
	const cur = clientTotals(lines, month);
	const activePrev = [...prev].filter(([client, value]) => client && value > EPS).map(([client]) => client);
	const active = [...cur].filter(([client, value]) => client && value > EPS).map(([client]) => client);
	const lost = activePrev.filter((client) => (cur.get(client) ?? 0) <= EPS);

	return { active: active.length, activePrev: activePrev.length, lost: lost.length, logoChurn: ratio(lost.length, activePrev.length) };
}

export interface ClientActivityMonth {
	period: Month;
	active: number;
	new: number;
	reactivated: number;
	churned: number;
	logo_churn: number | null;
}

/**
 * Altas y bajas de clientes por mes con toda la historia anterior (las líneas deben venir desde el primer mes con datos):
 * nuevo = primer MRR > 0 de su historia; reactivado = vuelve a MRR > 0 después de haber tenido y quedar en 0.
 */
export function clientActivity(lines: MrrLine[], history: Month[], months: Month[]): ClientActivityMonth[] {
	const seen = new Set<string>();
	const byMonth = new Map<Month, Map<string, number>>();

	for (const month of history) byMonth.set(month, clientTotals(lines, month));

	const out: ClientActivityMonth[] = [];

	for (const month of history) {
		const cur = byMonth.get(month) ?? new Map();
		const prev = byMonth.get(addMonths(month, -1)) ?? new Map();
		const active = [...cur].filter(([client, value]) => client && value > EPS).map(([client]) => client);
		const activePrev = [...prev].filter(([client, value]) => client && value > EPS).map(([client]) => client);
		const newClients = active.filter((client) => !seen.has(client));
		const reactivated = active.filter((client) => seen.has(client) && (prev.get(client) ?? 0) <= EPS);
		const churned = activePrev.filter((client) => (cur.get(client) ?? 0) <= EPS);

		for (const client of active) seen.add(client);
		if (months.includes(month)) {
			out.push({
				period: month,
				active: active.length,
				new: newClients.length,
				reactivated: reactivated.length,
				churned: churned.length,
				logo_churn: ratio(churned.length, activePrev.length),
			});
		}
	}

	return out;
}

export interface CohortRow {
	cohort: string;
	size: number;
	initial_mrr: number;
	/** % de la cohorte en cada período desde su inicio (0 = el período de inicio). `null` = aún no llega. */
	values: Array<number | null>;
}

const quarterOf = (month: Month) => `${month.slice(0, 4)}-T${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}`;

/** Cohortes por mes (o trimestre) del primer MRR > 0 del cliente (§1.6). `revenue` puede pasar de 100 %. */
export function buildCohorts(
	lines: MrrLine[],
	history: Month[],
	basis: 'revenue' | 'logos',
	grain: 'month' | 'quarter',
	maxCohorts = 24
): CohortRow[] {
	const byMonth = new Map(history.map((month) => [month, clientTotals(lines, month)]));
	const first = new Map<string, Month>();

	for (const month of history) {
		for (const [client, value] of byMonth.get(month) ?? []) {
			if (client && value > EPS && !first.has(client)) first.set(client, month);
		}
	}

	const periodOf = grain === 'month' ? (month: Month) => month : quarterOf;
	const periods = [...new Set(history.map(periodOf))];
	const lastMonthOf = new Map<string, Month>();

	for (const month of history) lastMonthOf.set(periodOf(month), month);

	const cohorts = new Map<string, string[]>();

	for (const [client, month] of first) cohorts.set(periodOf(month), [...(cohorts.get(periodOf(month)) ?? []), client]);

	return [...cohorts.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.slice(-maxCohorts)
		.map(([cohort, clients]) => {
			const start = periods.indexOf(cohort);
			const valueIn = (period: string) => {
				const month = lastMonthOf.get(period)!;
				const totals = byMonth.get(month) ?? new Map();

				return basis === 'revenue'
					? clients.reduce((sum, client) => sum + Math.max(totals.get(client) ?? 0, 0), 0)
					: clients.filter((client) => (totals.get(client) ?? 0) > EPS).length;
			};
			const initial = valueIn(cohort);

			return {
				cohort,
				size: clients.length,
				initial_mrr: round2(clients.reduce((sum, client) => sum + Math.max(byMonth.get(first.get(client)!)?.get(client) ?? 0, 0), 0)),
				values: periods.slice(start).map((period) => (initial > EPS ? Math.round((valueIn(period) / initial) * 10000) / 10000 : null)),
			};
		});
}
