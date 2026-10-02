import { addMonths, type Month } from './metrics-period';

/**
 * Saldos del devengo (spec-revenue-y-metricas §1.7). Lógica pura sobre filas ítem × mes del RSM ya leídas en una moneda.
 * Diferido y por facturar se calculan **por contrato** (netting, como Zuora): los `*_eom` del RSM son por fila y no se pueden sumar.
 */

export interface RevenueItemMonth {
	contractId: string;
	itemId: string;
	companyId: string;
	period: Month;
	recognized: number;
	billed: number;
	/** Acumulados del ítem al cierre del mes (uno por ítem-mes: la cola de churn repite el acumulado en dos filas, R4). */
	recognizedCum: number;
	billedCum: number;
}

const EPS = 0.005;
const round2 = (value: number) => Math.round(value * 100) / 100;

/** Índice ítem → filas ordenadas por mes, para leer "el último mes ≤ M" (después del fin del contrato el saldo queda donde quedó). */
export function indexByItem(rows: RevenueItemMonth[]): Map<string, RevenueItemMonth[]> {
	const byItem = new Map<string, RevenueItemMonth[]>();

	for (const row of rows) {
		const list = byItem.get(row.itemId);

		if (list) list.push(row);
		else byItem.set(row.itemId, [row]);
	}
	for (const list of byItem.values()) list.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));

	return byItem;
}

function lastAtOrBefore(list: RevenueItemMonth[], month: Month): RevenueItemMonth | undefined {
	let found: RevenueItemMonth | undefined;

	for (const row of list) {
		if (row.period > month) break;
		found = row;
	}

	return found;
}

/** Saldo neto por contrato al cierre de `month`: Σ (facturado acumulado − reconocido acumulado) de sus ítems. */
export function contractNets(byItem: Map<string, RevenueItemMonth[]>, month: Month): Map<string, number> {
	const nets = new Map<string, number>();

	for (const list of byItem.values()) {
		const row = lastAtOrBefore(list, month);

		if (row) nets.set(row.contractId, (nets.get(row.contractId) ?? 0) + row.billedCum - row.recognizedCum);
	}

	return nets;
}

/** Diferido (pasivo) y por facturar (activo contractual) al cierre de `month`, con netting por contrato. */
export function balancesAt(byItem: Map<string, RevenueItemMonth[]>, month: Month): { deferred: number; unbilled: number } {
	let deferred = 0;
	let unbilled = 0;

	for (const net of contractNets(byItem, month).values()) {
		if (net > EPS) deferred += net;
		else if (net < -EPS) unbilled -= net;
	}

	return { deferred: round2(deferred), unbilled: round2(unbilled) };
}

const sumIn = (rows: RevenueItemMonth[], months: Set<Month>, field: 'recognized' | 'billed') =>
	round2(rows.filter((row) => months.has(row.period)).reduce((sum, row) => sum + row[field], 0));

export interface Rollforward {
	deferred: { opening: number; billed: number; recognized: number; unbilled_change: number; fx: number; closing: number };
	unbilled: { opening: number; change: number; closing: number };
	check: number;
}

/**
 * Roll-forward del período (Stripe/Maxio/Recurly): diferido inicial + facturado − reconocido + variación de por facturar + tipo de
 * cambio = diferido final. El tipo de cambio es la diferencia que deja la conversión mensual de los acumulados (R7); en moneda de
 * contrato es 0. `check` = 0 por construcción.
 */
export function rollforward(rows: RevenueItemMonth[], months: Month[]): Rollforward {
	const byItem = indexByItem(rows);
	const opening = balancesAt(byItem, addMonths(months[0], -1));
	const closing = balancesAt(byItem, months[months.length - 1]);
	const range = new Set(months);
	const billed = sumIn(rows, range, 'billed');
	const recognized = sumIn(rows, range, 'recognized');
	const unbilledChange = round2(closing.unbilled - opening.unbilled);
	const fx = round2(closing.deferred - opening.deferred - billed + recognized - unbilledChange);

	return {
		deferred: { opening: opening.deferred, billed, recognized, unbilled_change: unbilledChange, fx, closing: closing.deferred },
		unbilled: { opening: opening.unbilled, change: unbilledChange, closing: closing.unbilled },
		check: round2(closing.deferred - opening.deferred - (billed - recognized + unbilledChange + fx)),
	};
}

export interface ForwardMonth {
	period: Month;
	from_deferred: number;
	unbilled_backlog: number;
}

/**
 * Reconocimiento futuro (RPO, NetSuite/Recurly; IFRS 15 §120): lo que el devengo reconocerá después de `asOf`, separado en lo ya
 * facturado (consume el diferido de su contrato en orden) y lo que falta facturar. `futureRows` = filas de meses > `asOf`.
 */
export function forwardSchedule(rows: RevenueItemMonth[], futureRows: RevenueItemMonth[], asOf: Month, horizon = 12) {
	const nets = contractNets(indexByItem(rows), asOf);
	const remaining = new Map([...nets].map(([contract, net]) => [contract, Math.max(net, 0)]));
	const byMonth = new Map<Month, { from_deferred: number; unbilled_backlog: number }>();
	const sorted = [...futureRows].sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));

	for (const row of sorted) {
		if (row.period <= asOf || row.recognized === 0) continue;
		const available = remaining.get(row.contractId) ?? 0;
		const fromDeferred = row.recognized > 0 ? Math.min(available, row.recognized) : 0;
		const bucket = byMonth.get(row.period) ?? { from_deferred: 0, unbilled_backlog: 0 };

		remaining.set(row.contractId, available - fromDeferred);
		bucket.from_deferred += fromDeferred;
		bucket.unbilled_backlog += row.recognized - fromDeferred;
		byMonth.set(row.period, bucket);
	}

	const months: ForwardMonth[] = [];
	let thereafter = { from_deferred: 0, unbilled_backlog: 0 };

	for (const [period, bucket] of [...byMonth].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (period <= addMonths(asOf, horizon))
			months.push({ period, from_deferred: round2(bucket.from_deferred), unbilled_backlog: round2(bucket.unbilled_backlog) });
		else
			thereafter = {
				from_deferred: thereafter.from_deferred + bucket.from_deferred,
				unbilled_backlog: thereafter.unbilled_backlog + bucket.unbilled_backlog,
			};
	}

	const shortTerm = months.reduce((sum, month) => sum + month.from_deferred + month.unbilled_backlog, 0);
	const longTerm = thereafter.from_deferred + thereafter.unbilled_backlog;

	return {
		months,
		thereafter: { from_deferred: round2(thereafter.from_deferred), unbilled_backlog: round2(thereafter.unbilled_backlog) },
		short_term: round2(shortTerm),
		long_term: round2(longTerm),
		total: round2(shortTerm + longTerm),
	};
}

export interface JournalEntry {
	account: 'revenue' | 'deferred' | 'unbilled';
	debit: number;
	credit: number;
}

export interface JournalMonth {
	period: Month;
	recognized: number;
	entries: JournalEntry[];
	balanced: boolean;
	/** Diferencia entre la variación de saldos y (facturado − reconocido): tipo de cambio de la conversión mensual. */
	fx_difference: number;
}

const side = (amount: number) => (amount >= 0 ? { debit: round2(amount), credit: 0 } : { debit: 0, credit: round2(-amount) });

/**
 * Asientos del reconocimiento por mes (una compañía, su moneda): Cr Ingresos = reconocido; Dr Diferido = lo que el reconocido consume
 * del diferido disponible del contrato (saldo inicial + facturado del mes); Dr Por facturar = el resto. Un reconocido negativo (NC de
 * descuento) revierte contra el diferido. Cuadra por construcción; `fx_difference` concilia contra los saldos.
 */
export function journalMonths(rows: RevenueItemMonth[], months: Month[]): JournalMonth[] {
	const byItem = indexByItem(rows);

	return months.map((month) => {
		const opening = contractNets(byItem, addMonths(month, -1));
		const closing = contractNets(byItem, month);
		const perContract = new Map<string, { recognized: number; billed: number }>();

		for (const row of rows) {
			if (row.period !== month) continue;
			const entry = perContract.get(row.contractId) ?? { recognized: 0, billed: 0 };

			entry.recognized += row.recognized;
			entry.billed += row.billed;
			perContract.set(row.contractId, entry);
		}

		let recognized = 0;
		let fromDeferred = 0;
		let toUnbilled = 0;
		let billed = 0;

		for (const [contract, { recognized: rec, billed: bill }] of perContract) {
			const available = Math.max((opening.get(contract) ?? 0) + bill, 0);
			const deferredPart = rec > 0 ? Math.min(rec, available) : rec;

			recognized += rec;
			billed += bill;
			fromDeferred += deferredPart;
			toUnbilled += rec - deferredPart;
		}

		const net = (map: Map<string, number>) => [...map.values()].reduce((sum, value) => sum + value, 0);
		const entries: JournalEntry[] = [
			{ account: 'deferred', ...side(fromDeferred) },
			{ account: 'unbilled', ...side(toUnbilled) },
			{ account: 'revenue', ...side(-recognized) },
		].filter((entry) => entry.debit !== 0 || entry.credit !== 0) as JournalEntry[];
		const debit = entries.reduce((sum, entry) => sum + entry.debit, 0);
		const credit = entries.reduce((sum, entry) => sum + entry.credit, 0);

		return {
			period: month,
			recognized: round2(recognized),
			entries,
			balanced: Math.abs(debit - credit) < 0.02,
			fx_difference: round2(net(closing) - net(opening) - (billed - recognized)),
		};
	});
}
