/**
 * Materializar un ajuste pactado (`…/scheduled-changes/:changeId/apply`, spec modificaciones §9.3.6): arma el pedido de modificación
 * (`renewal` / `item_change`) con el valor del pacto. Las filas (lectura, validación, INSERT) viven en `scheduled-change-rows.ts`.
 */
import { nextPeriodStart } from './billing-engine';
import {
	anchorDayOf,
	anchorOfItem,
	type ChangeBlocker,
	type ChangeContext,
	type ChangeItemRow,
	engineShape,
	indexVariation,
	itemMonthly,
	type PlanOptions,
	roundPactUnit,
} from './contract-changes';
import { buildItemGroups } from './contract-items';
import { frequencyOfMonths, type ScheduledChangeRow } from './scheduled-change-rows';

import type { ContractChangeRequestDto } from './dtos/contract-changes.dto';
import type { ApplyScheduledChangeDto } from './dtos/contract-scheduled-changes.dto';

const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const REMOVAL_CATEGORIES = new Set(['CHURN', 'DOWNSELL']);

// ------------------------------------------------------------------ materializar un pacto (apply)

/** Ítem vivo que hoy representa al ítem del pacto (sigue la cadena de renovaciones `renewed_by_item_id`). */
export function currentItemOf(items: ChangeItemRow[], itemId: string): ChangeItemRow | null {
	let item = items.find((row) => row.id === itemId) ?? null;
	const seen = new Set<string>();

	while (item?.renewed_by_item_id && !seen.has(item.id)) {
		seen.add(item.id);
		item = items.find((row) => row.id === item!.renewed_by_item_id) ?? item;
		if (seen.has(item.id)) break;
	}

	return item;
}

/** Fecha del pacto que toca aplicar: `on_date` = su fecha; `every_n_months` = la próxima; `on_renewal` = null. */
export const pactDate = (pact: ScheduledChangeRow): string | null =>
	pact.trigger === 'on_date' ? pact.effective_date : pact.trigger === 'every_n_months' ? (pact.next_effective_date ?? pact.anchor_date) : null;

export type PactApplication =
	| { request: ContractChangeRequestDto; options: PlanOptions; blockers: [] }
	| { request: ContractChangeRequestDto; options: PlanOptions; blockers: ChangeBlocker[] };

/**
 * Pedido de modificación que materializa un pacto (`…/scheduled-changes/:changeId/apply`): `on_renewal` → `renewal` de sus ítems (el
 * plan aplica el pacto con su valor o el pedido); precio/cantidad/índice en fecha → `item_change` desde el **próximo inicio de período**
 * del ítem en o después de la fecha del pacto (reajuste sin prorrateo); plazo/frecuencia → `item_change` con `billing_frequency` /
 * `term_months` (§9.3.7). Índice sin dato → blocker `index_value_missing` (el preview lo muestra; no se aplica en silencio).
 */
export function pactApplication(ctx: ChangeContext, pact: ScheduledChangeRow, dto: ApplyScheduledChangeDto): PactApplication {
	const anchor = anchorDayOf(ctx.contract, ctx.items);
	const live = ctx.items.filter(
		(item) =>
			item.is_recurring !== false &&
			!REMOVAL_CATEGORIES.has(item.categoria ?? '') &&
			!item.churn_date &&
			!item.renewed_by_item_id &&
			item.start_date
	);
	const targets = pact.contract_item_id
		? [currentItemOf(ctx.items, pact.contract_item_id)].filter((item): item is ChangeItemRow => Boolean(item))
		: live.filter((item) => !item.related_item_id);
	const base = { origin: { type: 'manual' as const }, reason: dto.reason?.trim() || `Ajuste pactado (${pact.kind})`, notes: dto.notes };
	const override = dto.value === null || dto.value === undefined ? null : Number(dto.value);
	const options = (value: number): PlanOptions => ({
		scheduled_change: {
			id: pact.id,
			value,
			kind: pact.kind,
			trigger: pact.trigger,
			effective_date: pactDate(pact),
			interval_months: pact.interval_months,
		},
	});

	if (pact.trigger === 'on_renewal') {
		return {
			request: {
				...base,
				effective_date: dto.effective_date ?? ctx.today,
				change: { type: 'renewal', items: targets.map((item) => ({ item_id: item.id })) },
			},
			options: options(override ?? pact.value),
			blockers: [],
		};
	}
	const date = pactDate(pact) ?? ctx.today;
	const effectiveFor = (item: ChangeItemRow) =>
		dto.effective_date ??
		(item.start_date && item.start_date >= date
			? item.start_date
			: (nextPeriodStart(engineShape(item), anchorOfItem(item, anchor), date) ?? date));
	const effective = targets.map(effectiveFor).sort()[0] ?? date;
	const groups = buildItemGroups(ctx.items, effective);
	let applied = override ?? pact.value;
	const blockers: ChangeBlocker[] = [];
	const items = targets.map((item) => {
		const group = groups.find((row) => row.item_ids.includes(item.id));
		const quantity = group?.quantity ?? toNumber(item.quantity);
		const pct = item.discount_type === 'Porcentaje' ? toNumber(item.discount_value) : 0;
		const mrr = group?.mrr ?? itemMonthly(item);
		const unit = quantity > 0 && pct < 100 ? mrr / (quantity * (1 - pct / 100)) : toNumber(item.unit_price);
		const ref: Record<string, unknown> = { item_id: item.id, quantity, unit_price: Math.round(unit * 1e6) / 1e6 };

		switch (pact.kind) {
			case 'quantity':
				ref.quantity = applied;
				break;
			case 'new_unit_price':
				ref.unit_price = roundPactUnit(applied, quantity, pact.rounding);
				break;
			case 'percent_uplift':
				ref.unit_price = roundPactUnit(unit * (1 + applied / 100), quantity, pact.rounding);
				break;
			case 'index': {
				const variation = override !== null ? { percent: override } : indexVariation(pact, ctx.index_series, date);

				if (!variation) {
					blockers.push({
						code: 'index_value_missing',
						message: `No hay valor publicado del índice ${pact.index_code ?? ''} para el reajuste del ${date}`.replace(/\s+/g, ' '),
						next_step: 'Espera la publicación del índice o aplica el pacto con un valor (value) explícito',
					});
					break;
				}
				applied = variation.percent;
				ref.unit_price = roundPactUnit(unit * (1 + variation.percent / 100), quantity, pact.rounding);
				break;
			}
			case 'term':
				ref.term_months = Math.round(applied);
				break;
			case 'billing_frequency':
				ref.billing_frequency = frequencyOfMonths(applied);
				break;
		}

		return ref;
	});

	return {
		request: { ...base, effective_date: effective, change: { type: 'item_change', items } },
		options: options(applied),
		blockers,
	};
}
