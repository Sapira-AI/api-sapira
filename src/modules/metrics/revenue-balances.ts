import type { AccountMappingKey } from '@/core/utils/account-mappings';

import { addMonths, type Month } from './metrics-period';

/**
 * Saldos del devengo (spec-revenue-y-metricas §1.7). Lógica pura sobre filas ítem × mes del RSM ya leídas en una moneda.
 * Diferido y por facturar se calculan **por contrato** (netting, como Zuora): los `*_eom` del RSM son por fila y no se pueden sumar.
 */

/** Atributos estáticos del ítem para abrir los asientos por dimensión (mismas fuentes que Métricas "por dimensión": `clients.*`). */
export interface ItemAttributes {
	contractNumber?: string | null;
	clientId?: string | null;
	clientName?: string | null;
	product?: string | null;
	market?: string | null;
	industry?: string | null;
	segment?: string | null;
}

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
	attrs?: ItemAttributes;
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

/** Dimensión por la que se abren los asientos dentro de la compañía (Domi 02-10). */
export type JournalGroupBy = 'market' | 'industry' | 'segment' | 'contract' | 'client' | 'product';

/** Cuentas del asiento: las 5 del mapping (`company_account_mappings`, Configuración › Compañía 360). */
export type JournalAccount = AccountMappingKey;

/**
 * Líneas del asiento del mes (spec §1.7 "Asientos"): (a) facturación a diferido, (b) reconocimiento desde diferido, (c) reconocimiento
 * no facturado, (d) facturación de lo ya reconocido y la diferencia de cambio de la conversión mensual sobre diferido o por facturar.
 */
export type JournalLineKind =
	| 'billing_deferred'
	| 'recognition_deferred'
	| 'recognition_unbilled'
	| 'billing_unbilled'
	| 'fx_deferred'
	| 'fx_unbilled';

export const JOURNAL_LINES: Record<JournalLineKind, { debit: JournalAccount; credit: JournalAccount; memo: string }> = {
	billing_deferred: { debit: 'receivable', credit: 'deferred', memo: 'Facturación del período a ingresos diferidos' },
	recognition_deferred: { debit: 'deferred', credit: 'revenue', memo: 'Reconocimiento desde ingresos diferidos' },
	recognition_unbilled: { debit: 'unbilled', credit: 'revenue', memo: 'Reconocimiento no facturado (activo de contrato)' },
	billing_unbilled: { debit: 'receivable', credit: 'unbilled', memo: 'Facturación de ingresos ya reconocidos' },
	fx_deferred: { debit: 'fx_difference', credit: 'deferred', memo: 'Diferencia de cambio de la conversión mensual (diferido)' },
	fx_unbilled: { debit: 'fx_difference', credit: 'unbilled', memo: 'Diferencia de cambio de la conversión mensual (por facturar)' },
};

const LINE_ORDER = Object.keys(JOURNAL_LINES) as JournalLineKind[];
const ACCOUNT_ORDER: JournalAccount[] = ['receivable', 'deferred', 'unbilled', 'revenue', 'fx_difference'];

/** Valor de la dimensión: filas sin dato → "Sin asignar". */
export const UNASSIGNED = { key: '__none__', label: 'Sin asignar' };

export interface JournalGroup {
	key: string;
	label: string;
}

/** Una pierna del asiento (una cuenta, debe o haber): formato que se pega en un ERP. */
export interface JournalPosting {
	line: JournalLineKind;
	group: JournalGroup | null;
	account: JournalAccount;
	debit: number;
	credit: number;
}

/** Total por cuenta del mes (debe y haber brutos). */
export interface JournalEntry {
	account: JournalAccount;
	debit: number;
	credit: number;
}

/** Saldo de una cuenta de balance: inicial + movimiento del período = final (`difference` = 0 si concilia). */
export interface JournalBalance {
	opening: number;
	debit: number;
	credit: number;
	movement: number;
	closing: number;
	difference: number;
	reconciles: boolean;
}

export interface JournalGroupTotal extends JournalGroup {
	debit: number;
	credit: number;
	balanced: boolean;
}

export interface JournalMonth {
	period: Month;
	recognized: number;
	billed: number;
	/** Totales por cuenta (debe y haber brutos de todas las líneas). */
	entries: JournalEntry[];
	postings: JournalPosting[];
	balances: { deferred: JournalBalance; unbilled: JournalBalance };
	/** Subtotal por valor de la dimensión (vacío sin apertura). Cada uno cuadra: cada línea es un par debe = haber. */
	groups: JournalGroupTotal[];
	balanced: boolean;
	/** Diferencia de cambio de la conversión mensual: Σ líneas de tipo de cambio = `fx` del roll-forward. */
	fx_difference: number;
}

const side = (amount: number) => (amount >= 0 ? { debit: round2(amount), credit: 0 } : { debit: 0, credit: round2(-amount) });
const sumOf = (values: Iterable<number>) => [...values].reduce((sum, value) => sum + value, 0);

/** Grupo de un ítem según la dimensión (mismas fuentes que Métricas: cliente, `clients.market|industry|segment`, producto del ítem). */
export function journalGroupOf(row: Pick<RevenueItemMonth, 'contractId' | 'attrs'>, groupBy: JournalGroupBy): JournalGroup {
	const attrs = row.attrs ?? {};
	const named = (value: string | null | undefined, key = value) => (value ? { key: key ?? value, label: value } : UNASSIGNED);

	switch (groupBy) {
		case 'contract':
			return { key: row.contractId, label: attrs.contractNumber ?? 'Suscripción' };
		case 'client':
			return attrs.clientId ? { key: attrs.clientId, label: attrs.clientName ?? attrs.clientId } : UNASSIGNED;
		default:
			return named(attrs[groupBy]);
	}
}

/** Reparte `amount` entre grupos en proporción a la primera base con total ≠ 0; si ninguna sirve, todo al primer grupo. */
function allocate(amount: number, bases: Array<Map<string, number>>, groups: string[]): Map<string, number> {
	if (groups.length === 1) return new Map([[groups[0], amount]]);
	for (const base of bases) {
		const total = sumOf(base.values());

		if (Math.abs(total) > EPS) return new Map(groups.map((key) => [key, (amount * (base.get(key) ?? 0)) / total]));
	}

	return new Map([[groups[0], amount]]);
}

/**
 * Líneas (a)–(d) y tipo de cambio de UN contrato en un mes (netting por contrato, la misma regla de saldos del roll-forward):
 *
 * - `net = Σ billed_cum − Σ recognized_cum`; diferido D = max(net, 0); por facturar U = max(−net, 0) (inicial = cierre del mes anterior).
 * - tipo de cambio `fx = (net final − net inicial) − (facturado − reconocido)`: va contra por facturar si el contrato no tuvo diferido
 *   ni al inicio ni al cierre; si no, contra diferido (como el roll-forward).
 * - `Ut = ΔU + fx` si el fx va contra por facturar, si no `Ut = ΔU`: movimiento de por facturar que explican (c) − (d).
 * - Ut ≥ 0: (c) = min(Ut, max(reconocido, 0)), (d) = (c) − Ut. Ut < 0: (d) = min(−Ut, max(facturado, 0)), (c) = (d) + Ut.
 * - (a) = facturado − (d); (b) = reconocido − (c).
 *
 * Así (a)+(d) = facturado, (b)+(c) = reconocido, (a) − (b) + fx diferido = ΔD y (c) − (d) − fx por facturar = ΔU: cada saldo concilia.
 */
export function contractJournalLines(input: {
	netOpening: number;
	netClosing: number;
	billed: number;
	recognized: number;
}): Record<JournalLineKind, number> {
	const { netOpening, netClosing, billed, recognized } = input;
	const deferredOf = (net: number) => (net > EPS ? net : 0);
	const unbilledOf = (net: number) => (net < -EPS ? -net : 0);
	const fx = netClosing - netOpening - (billed - recognized);
	const fxOnUnbilled = deferredOf(netOpening) === 0 && deferredOf(netClosing) === 0 && (unbilledOf(netOpening) > 0 || unbilledOf(netClosing) > 0);
	const target = unbilledOf(netClosing) - unbilledOf(netOpening) + (fxOnUnbilled ? fx : 0);
	let recognizedUnbilled: number;
	let billedUnbilled: number;

	if (target >= 0) {
		recognizedUnbilled = Math.min(target, Math.max(recognized, 0));
		billedUnbilled = recognizedUnbilled - target;
	} else {
		billedUnbilled = Math.min(-target, Math.max(billed, 0));
		recognizedUnbilled = billedUnbilled + target;
	}

	return {
		billing_deferred: billed - billedUnbilled,
		recognition_deferred: recognized - recognizedUnbilled,
		recognition_unbilled: recognizedUnbilled,
		billing_unbilled: billedUnbilled,
		fx_deferred: fxOnUnbilled ? 0 : fx,
		fx_unbilled: fxOnUnbilled ? fx : 0,
	};
}

function emptyBalance(opening: number, closing: number): JournalBalance {
	return { opening, debit: 0, credit: 0, movement: 0, closing, difference: 0, reconciles: true };
}

/**
 * Asientos por mes (una compañía, su moneda) con el MOVIMIENTO del período de ambas cuentas de balance (spec §1.7 "Asientos"):
 * líneas (a)–(d) y tipo de cambio por contrato (`contractJournalLines`), sumadas por valor de la dimensión si se abre por una. Las
 * dimensiones de contrato (contrato, cliente, mercado, industria, segmento) toman el contrato entero; por producto, (a)/(d) se prorratean
 * por el facturado de cada ítem del contrato, (b)/(c) por su reconocido y el tipo de cambio es el de cada ítem (exacto). Cada línea es
 * un par debe = haber, así que el mes y cada subtotal cuadran por construcción; los saldos concilian con el roll-forward.
 */
export function journalMonths(rows: RevenueItemMonth[], months: Month[], groupBy?: JournalGroupBy | null): JournalMonth[] {
	const byItem = indexByItem(rows);
	const contractItems = new Map<string, string[]>();
	const itemGroup = new Map<string, JournalGroup | null>();

	for (const [itemId, list] of byItem) {
		const first = list[0];

		contractItems.set(first.contractId, [...(contractItems.get(first.contractId) ?? []), itemId]);
		itemGroup.set(itemId, groupBy ? journalGroupOf(first, groupBy) : null);
	}

	const itemNet = (itemId: string, month: Month) => {
		const row = lastAtOrBefore(byItem.get(itemId) ?? [], month);

		return row ? row.billedCum - row.recognizedCum : 0;
	};

	return months.map((month) => {
		const previous = addMonths(month, -1);
		const groupLabels = new Map<string, string>();
		const totals = new Map<string, Record<JournalLineKind, number>>();
		let recognized = 0;
		let billed = 0;

		const add = (key: string, kind: JournalLineKind, value: number) => {
			const bucket = totals.get(key) ?? (Object.fromEntries(LINE_ORDER.map((line) => [line, 0])) as Record<JournalLineKind, number>);

			bucket[kind] += value;
			totals.set(key, bucket);
		};

		for (const [, items] of contractItems) {
			const billedBy = new Map<string, number>();
			const recognizedBy = new Map<string, number>();
			const fxBy = new Map<string, number>();
			const netBy = new Map<string, number>();
			let netOpening = 0;
			let netClosing = 0;
			let contractBilled = 0;
			let contractRecognized = 0;

			for (const itemId of items) {
				const group = itemGroup.get(itemId) ?? null;
				const key = group?.key ?? '';
				const row = (byItem.get(itemId) ?? []).find((candidate) => candidate.period === month);
				const opening = itemNet(itemId, previous);
				const closing = itemNet(itemId, month);
				const itemBilled = row?.billed ?? 0;
				const itemRecognized = row?.recognized ?? 0;

				if (group) groupLabels.set(key, group.label);
				netOpening += opening;
				netClosing += closing;
				contractBilled += itemBilled;
				contractRecognized += itemRecognized;
				billedBy.set(key, (billedBy.get(key) ?? 0) + itemBilled);
				recognizedBy.set(key, (recognizedBy.get(key) ?? 0) + itemRecognized);
				fxBy.set(key, (fxBy.get(key) ?? 0) + closing - opening - (itemBilled - itemRecognized));
				netBy.set(key, (netBy.get(key) ?? 0) + closing);
			}
			if ([netOpening, netClosing, contractBilled, contractRecognized].every((value) => Math.abs(value) < EPS / 10)) continue;
			recognized += contractRecognized;
			billed += contractBilled;
			const lines = contractJournalLines({ netOpening, netClosing, billed: contractBilled, recognized: contractRecognized });
			const keys = [...billedBy.keys()];

			for (const kind of LINE_ORDER) {
				if (lines[kind] === 0) continue;
				const parts =
					kind === 'fx_deferred' || kind === 'fx_unbilled'
						? keys.length === 1
							? new Map([[keys[0], lines[kind]]])
							: fxBy
						: allocate(lines[kind], kind.startsWith('billing') ? [billedBy, recognizedBy, netBy] : [recognizedBy, billedBy, netBy], keys);

				for (const [key, value] of parts) if (value !== 0) add(key, kind, value);
			}
		}

		const ordered = [...totals.keys()].sort((a, b) =>
			a === UNASSIGNED.key ? 1 : b === UNASSIGNED.key ? -1 : (groupLabels.get(a) ?? a).localeCompare(groupLabels.get(b) ?? b, 'es')
		);
		const postings: JournalPosting[] = [];

		for (const key of ordered) {
			const group = groupBy ? { key, label: groupLabels.get(key) ?? UNASSIGNED.label } : null;

			for (const kind of LINE_ORDER) {
				const amount = round2(totals.get(key)![kind]);

				if (amount === 0) continue;
				const { debit, credit } = JOURNAL_LINES[kind];
				const pair = side(amount);

				postings.push({ line: kind, group, account: debit, debit: pair.debit, credit: pair.credit });
				postings.push({ line: kind, group, account: credit, debit: pair.credit, credit: pair.debit });
			}
		}

		const entries = ACCOUNT_ORDER.map((account) => {
			const own = postings.filter((posting) => posting.account === account);

			return {
				account,
				debit: round2(sumOf(own.map((posting) => posting.debit))),
				credit: round2(sumOf(own.map((posting) => posting.credit))),
			};
		}).filter((entry) => entry.debit !== 0 || entry.credit !== 0);
		const opening = balancesAt(byItem, previous);
		const closing = balancesAt(byItem, month);
		const balanceOf = (account: 'deferred' | 'unbilled'): JournalBalance => {
			const entry = entries.find((candidate) => candidate.account === account);
			const balance = emptyBalance(opening[account], closing[account]);

			if (!entry)
				return {
					...balance,
					difference: round2(opening[account] - closing[account]),
					reconciles: Math.abs(opening[account] - closing[account]) < 0.02,
				};
			// Diferido es pasivo (sube por el haber); por facturar es activo (sube por el debe).
			const movement = round2(account === 'deferred' ? entry.credit - entry.debit : entry.debit - entry.credit);
			const difference = round2(opening[account] + movement - closing[account]);
			const lines = postings.filter((posting) => posting.account === account).length;

			return {
				...balance,
				debit: entry.debit,
				credit: entry.credit,
				movement,
				difference,
				reconciles: Math.abs(difference) <= Math.max(0.02, 0.005 * lines),
			};
		};
		const debit = sumOf(entries.map((entry) => entry.debit));
		const credit = sumOf(entries.map((entry) => entry.credit));
		const groups: JournalGroupTotal[] = groupBy
			? ordered.map((key) => {
					const own = postings.filter((posting) => posting.group?.key === key);
					const groupDebit = round2(sumOf(own.map((posting) => posting.debit)));
					const groupCredit = round2(sumOf(own.map((posting) => posting.credit)));

					return {
						key,
						label: groupLabels.get(key) ?? UNASSIGNED.label,
						debit: groupDebit,
						credit: groupCredit,
						balanced: Math.abs(groupDebit - groupCredit) < 0.02,
					};
				})
			: [];

		return {
			period: month,
			recognized: round2(recognized),
			billed: round2(billed),
			entries,
			postings,
			balances: { deferred: balanceOf('deferred'), unbilled: balanceOf('unbilled') },
			groups,
			balanced: Math.abs(debit - credit) < 0.02,
			fx_difference: round2(sumOf([...totals.values()].map((bucket) => bucket.fx_deferred + bucket.fx_unbilled))),
		};
	});
}
