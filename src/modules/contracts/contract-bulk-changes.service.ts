import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { holdingTimezone } from '@/core/utils/holding-preferences';

import { todayFor } from './business-date';
import { type ChangeContext, type ChangeItemRow } from './contract-changes';
import { ContractChangesService } from './contract-changes.service';
import { ContractScheduledChangesService } from './contract-scheduled-changes.service';
import { hasPriceModel } from './scheduled-changes';

import type { BulkAutoRenewDto, BulkScheduledChangeDto } from './dtos/bulk-contracts.dto';
import type { ContractChangeRequestDto } from './dtos/contract-changes.dto';
import type { CreateScheduledChangeDto } from './dtos/contract-scheduled-changes.dto';

type Row = Record<string, unknown>;

const REMOVAL_CATEGORIES = new Set(['CHURN', 'DOWNSELL']);
const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const round2 = (value: number) => Math.round(value * 100) / 100;
const messageOf = (error: unknown) => {
	const response = (error as { getResponse?: () => unknown }).getResponse?.();
	const errors = response && typeof response === 'object' ? ((response as Row).errors as Array<{ message: string }> | undefined) : undefined;

	if (errors?.length) return errors.map((entry) => entry.message).join('; ');

	return error instanceof Error ? error.message : String(error);
};

/** Fila de la vista previa del ajuste de precio en lote (una por contrato). */
export interface BulkScheduledChangeRow {
	id: string;
	contract_number: string | null;
	client_name: string | null;
	currency: string | null;
	/** Se guardará como cambio futuro (`can_save`) o se omite con su motivo. */
	can_save: boolean;
	skip_reason: string | null;
	/** Cómo rige: en su fecha, cada N meses o al renovarse (también cuando el contrato termina antes de la fecha pedida). */
	applies: 'on_date' | 'on_renewal' | 'every_n_months' | null;
	effective_date: string | null;
	items: number;
	/** Ítems con modelo de precio (tramos, consumo): no entran en el reajuste. */
	items_excluded: number;
	/** Con filtro de productos: nombres de los ítems que reciben el cambio (null = todo el contrato). */
	products: string[] | null;
	mrr_before: number | null;
	mrr_after: number | null;
	/** Lo que hoy impediría aplicarlo (no impide guardarlo: se reintenta cada día). */
	blockers: string[];
	warnings: string[];
}

export interface BulkAutoRenewRow {
	id: string;
	contract_number: string | null;
	client_name: string | null;
	can_apply: boolean;
	skip_reason: string | null;
	end_date: string | null;
	items_to_change: number;
	/** Estado actual de la renovación automática del contrato: todos sus ítems, algunos o ninguno. */
	current: 'on' | 'partial' | 'off' | null;
	items_on: number;
	items_total: number;
}

/**
 * Acciones masivas de la lista de contratos que cambian el contrato (Domi 13-11, SimpliRoute fin de año):
 * - **Programar cambio**: el mismo cambio futuro del 360 (`contract_scheduled_changes`, alcance contrato) en cada contrato. En una fecha,
 *   cada ítem lo toma desde su primer período en o después de ella (lo ya facturado no se ajusta); si el contrato termina antes, rige al
 *   renovarse (`on_renewal`). Un reajuste de precio no toca ítems con modelo de precio. El job diario lo aplica solo. Con `product_ids`
 *   (usuarias 13-11) el cambio va solo a los ítems de esos productos: un cambio de alcance ítem por cada uno.
 * - **Renovación automática**: enciende o apaga `auto_renew` de los ítems recurrentes vigentes (cambio `billing_conditions`); encendida,
 *   el job `contracts-auto-renewal` renueva 30 días antes del fin.
 * Vista previa por contrato sin escribir; al guardar, cada contrato va en su propia transacción (uno que falla no detiene al resto).
 */
@Injectable()
export class ContractBulkChangesService {
	private readonly logger = new Logger(ContractBulkChangesService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly changes: ContractChangesService,
		private readonly scheduledChanges: ContractScheduledChangesService
	) {}

	// ---------------------------------------------------------------- ajuste de precio

	async previewScheduledChange(dto: BulkScheduledChangeDto, holdingId: string, now = new Date()) {
		const today = todayFor(await holdingTimezone(this.dataSource, holdingId), now);
		const heads = await this.heads(dto.ids, holdingId);
		const data: BulkScheduledChangeRow[] = [];

		for (const id of [...new Set(dto.ids)]) data.push((await this.planScheduledChange(id, heads.get(id), dto, holdingId, today)).row);

		return { data, summary: this.priceSummary(data) };
	}

	async applyScheduledChange(dto: BulkScheduledChangeDto, holdingId: string, authId: string, now = new Date()) {
		const today = todayFor(await holdingTimezone(this.dataSource, holdingId), now);
		const heads = await this.heads(dto.ids, holdingId);
		const created: Array<{
			id: string;
			contract_number: string | null;
			scheduled_change_id: string;
			scheduled_change_ids: string[];
			applies: string;
		}> = [];
		const skipped: Array<{ id: string; contract_number: string | null; reason: string }> = [];
		const failed: Array<{ id: string; contract_number: string | null; message: string }> = [];

		for (const id of [...new Set(dto.ids)]) {
			const head = heads.get(id);
			const number = toText(head?.contract_number);

			try {
				const { row, pacts } = await this.planScheduledChange(id, head, dto, holdingId, today);

				if (!pacts.length || !row.can_save) {
					skipped.push({ id, contract_number: number, reason: row.skip_reason ?? 'No se puede guardar' });
					continue;
				}
				const ids: string[] = [];

				for (const pact of pacts) ids.push((await this.scheduledChanges.create(id, pact, holdingId, authId)).id);
				created.push({
					id,
					contract_number: number,
					scheduled_change_id: ids[0],
					scheduled_change_ids: ids,
					applies: row.applies ?? pacts[0].trigger,
				});
			} catch (error) {
				const message = messageOf(error);

				this.logger.warn(`Cambio futuro en lote: falló el contrato ${number ?? id}: ${message}`);
				failed.push({ id, contract_number: number, message });
			}
		}

		return { created, skipped, failed };
	}

	private async planScheduledChange(
		id: string,
		head: Row | undefined,
		dto: BulkScheduledChangeDto,
		holdingId: string,
		today: string
	): Promise<{ row: BulkScheduledChangeRow; pacts: CreateScheduledChangeDto[] }> {
		const base: BulkScheduledChangeRow = {
			id,
			contract_number: toText(head?.contract_number),
			client_name: toText(head?.client_name),
			currency: toText(head?.contract_currency),
			can_save: false,
			skip_reason: null,
			applies: null,
			effective_date: null,
			items: 0,
			items_excluded: 0,
			products: null,
			mrr_before: null,
			mrr_after: null,
			blockers: [],
			warnings: [],
		};
		const skip = (reason: string) => ({ row: { ...base, skip_reason: reason }, pacts: [] });

		if (!head) return skip('El contrato no existe en este holding');
		if (toText(head.status) !== 'Activo') return skip(`El contrato no está activo (${toText(head.status) ?? 'sin estado'})`);
		const change = dto.change;
		const priceKind = change.kind === 'percent_uplift' || change.kind === 'index' || change.kind === 'new_unit_price';
		const probe = { effective_date: today, change: { type: 'item_change' } } as ContractChangeRequestDto;
		let ctx: ChangeContext;

		if (change.contract_item_id || change.item_key) return skip('En lote el cambio aplica a todo el contrato, no a un ítem');
		try {
			ctx = await this.changes.loadContext(this.dataSource, id, holdingId, probe, today);
		} catch (error) {
			return skip(messageOf(error));
		}
		const live = ctx.items.filter(
			(item: ChangeItemRow) =>
				item.is_recurring !== false &&
				!REMOVAL_CATEGORIES.has(item.categoria ?? '') &&
				!item.churn_date &&
				!item.renewed_by_item_id &&
				!item.related_item_id &&
				item.start_date
		);
		// Filtro de productos (usuarias 13-11): el cambio va solo a los ítems de esos productos.
		const productIds = dto.product_ids?.length ? new Set(dto.product_ids) : null;
		const inScope = productIds ? live.filter((item) => item.product_id && productIds.has(item.product_id)) : live;
		// Un reajuste de precio no toca los ítems con modelo de precio (su valor sale de su tarifa).
		const adjustable = priceKind ? inScope.filter((item) => !hasPriceModel(item)) : inScope;

		base.items = adjustable.length;
		base.items_excluded = inScope.length - adjustable.length;
		if (!live.length) return skip('No tiene ítems recurrentes vigentes');
		if (!inScope.length) return skip('No tiene ítems vigentes de los productos elegidos');
		if (!adjustable.length)
			return skip(
				productIds
					? 'Sus ítems de esos productos usan un modelo de precio: el reajuste se hace editando su tarifa'
					: 'Todos sus ítems usan un modelo de precio: el reajuste se hace editando su tarifa'
			);
		const date = change.trigger === 'on_date' ? (change.effective_date ?? null) : null;
		const notes = change.notes?.trim() || 'Cambio programado guardado en lote';
		// "En una fecha" con el ítem (o el contrato) terminando antes: el cambio rige al renovarse (un solo evento, la renovación con el valor nuevo).
		const pactFor = (items: ChangeItemRow[], itemId: string | null): CreateScheduledChangeDto | null => {
			const endsBefore = Boolean(date) && items.every((item) => item.end_date && item.end_date < date!);
			const trigger = endsBefore ? 'on_renewal' : change.trigger;
			const duplicate = (ctx.scheduled_changes ?? []).find(
				(pact) =>
					pact.status === 'scheduled' &&
					pact.kind === change.kind &&
					pact.contract_item_id === itemId &&
					pact.trigger === trigger &&
					(trigger === 'on_renewal' ||
						(trigger === 'on_date'
							? pact.effective_date === date
							: (pact.next_effective_date ?? pact.anchor_date) === (change.anchor_date ?? null)))
			);

			if (duplicate) return null;
			const pact: CreateScheduledChangeDto = { ...change, trigger, rounding: change.rounding ?? 'unit_2', notes };

			if (itemId) pact.contract_item_id = itemId;
			if (endsBefore) delete pact.effective_date;

			return pact;
		};
		const scopes = productIds
			? adjustable.map((item) => ({ items: [item], itemId: item.id as string | null }))
			: [{ items: adjustable, itemId: null }];
		const pacts = scopes.map((scope) => pactFor(scope.items, scope.itemId)).filter((pact): pact is CreateScheduledChangeDto => Boolean(pact));

		if (!pacts.length) return skip('Ya tiene un cambio programado igual (mismo tipo y momento)');
		const scoped = productIds ? adjustable.filter((item) => pacts.some((pact) => pact.contract_item_id === item.id)) : adjustable;

		try {
			const previews = pacts.map((pact) => this.scheduledChanges.previewFor(ctx, pact));
			const before = scoped.reduce((sum, item) => sum + (Number(item.monthly_price) || 0), 0) + this.adjustmentsOf(ctx.items, scoped);
			const delta = previews.reduce((sum, preview) => sum + (Number(preview.rsm?.mrr_delta) || 0), 0);
			const onRenewal = pacts.every((pact) => pact.trigger === 'on_renewal');
			const unique = (values: string[]) => [...new Set(values)];

			return {
				pacts,
				row: {
					...base,
					items: scoped.length,
					products: productIds ? unique(scoped.map((item) => item.product_name ?? 'Producto')) : null,
					can_save: true,
					applies: onRenewal ? 'on_renewal' : change.trigger,
					effective_date: onRenewal
						? (scoped.map((item) => item.end_date).sort()[0] ?? null)
						: (previews
								.filter((_, index) => pacts[index].trigger !== 'on_renewal')
								.map((preview) => preview.effective_date)
								.sort()[0] ?? null),
					mrr_before: round2(before),
					mrr_after: round2(before + delta),
					blockers: unique(previews.flatMap((preview) => preview.blockers.map((blocker) => blocker.message))),
					warnings: unique(
						previews.flatMap((preview) =>
							preview.warnings.filter((warning) => warning.code !== 'generator').map((warning) => warning.message)
						)
					),
				},
			};
		} catch (error) {
			return skip(messageOf(error));
		}
	}

	/** Mensual de los ajustes vigentes (ampliaciones y reducciones) que cuelgan de los ítems dados. */
	private adjustmentsOf(items: ChangeItemRow[], parents: ChangeItemRow[]): number {
		const ids = new Set(parents.map((item) => item.id));

		return items
			.filter(
				(item) =>
					item.related_item_id &&
					ids.has(item.related_item_id) &&
					!item.churn_date &&
					!item.renewed_by_item_id &&
					item.is_recurring !== false
			)
			.filter((item) => item.categoria === 'UPSELL' || item.categoria === 'DOWNSELL')
			.reduce((sum, item) => sum + (Number(item.monthly_price) || 0), 0);
	}

	private priceSummary(rows: BulkScheduledChangeRow[]) {
		const ok = rows.filter((row) => row.can_save);

		return {
			contracts: rows.length,
			to_save: ok.length,
			skipped: rows.length - ok.length,
			on_date: ok.filter((row) => row.applies !== 'on_renewal').length,
			on_renewal: ok.filter((row) => row.applies === 'on_renewal').length,
			with_blockers: ok.filter((row) => row.blockers.length).length,
		};
	}

	// ---------------------------------------------------------------- renovación automática

	async previewAutoRenew(dto: BulkAutoRenewDto, holdingId: string) {
		const data = await this.autoRenewRows(dto, holdingId);
		const ok = data.filter((row) => row.can_apply);

		return { data, summary: { contracts: data.length, to_change: ok.length, skipped: data.length - ok.length } };
	}

	async applyAutoRenew(dto: BulkAutoRenewDto, holdingId: string, authId: string, now = new Date()) {
		const today = todayFor(await holdingTimezone(this.dataSource, holdingId), now);
		const rows = await this.autoRenewRows(dto, holdingId);
		const updated: Array<{ id: string; contract_number: string | null; items_changed: number }> = [];
		const skipped: Array<{ id: string; contract_number: string | null; reason: string }> = [];
		const failed: Array<{ id: string; contract_number: string | null; message: string }> = [];

		for (const row of rows) {
			if (!row.can_apply) {
				skipped.push({ id: row.id, contract_number: row.contract_number, reason: row.skip_reason ?? 'Sin cambios' });
				continue;
			}
			const request = {
				effective_date: today,
				origin: { type: 'manual' },
				reason: `Renovación automática ${dto.auto_renew ? 'encendida' : 'apagada'} en lote`,
				change: { type: 'billing_conditions', auto_renew: dto.auto_renew },
			} as ContractChangeRequestDto;

			try {
				await this.changes.apply(row.id, request, holdingId, authId, undefined, now);
				updated.push({ id: row.id, contract_number: row.contract_number, items_changed: row.items_to_change });
			} catch (error) {
				const message = messageOf(error);

				this.logger.warn(`Renovación automática en lote: falló el contrato ${row.contract_number ?? row.id}: ${message}`);
				failed.push({ id: row.id, contract_number: row.contract_number, message });
			}
		}

		return { updated, skipped, failed };
	}

	private async autoRenewRows(dto: BulkAutoRenewDto, holdingId: string): Promise<BulkAutoRenewRow[]> {
		const ids = [...new Set(dto.ids)];
		const rows = (await this.dataSource.query(
			`SELECT c.id, c.contract_number, c.status, cl.name_commercial AS client_name,
				(SELECT COUNT(*) FROM contract_items ci WHERE ci.contract_id = c.id AND ci.is_recurring = true AND ci.churn_date IS NULL
					AND ci.renewed_by_item_id IS NULL AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL'))::int AS live_items,
				(SELECT COUNT(*) FROM contract_items ci WHERE ci.contract_id = c.id AND ci.is_recurring = true AND ci.churn_date IS NULL
					AND ci.renewed_by_item_id IS NULL AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')
					AND COALESCE(ci.auto_renew, false) IS DISTINCT FROM $3::boolean)::int AS items_to_change,
				(SELECT COUNT(*) FROM contract_items ci WHERE ci.contract_id = c.id AND ci.is_recurring = true AND ci.churn_date IS NULL
					AND ci.renewed_by_item_id IS NULL AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL') AND ci.auto_renew = true)::int AS items_on,
				(SELECT MIN(ci.end_date)::text FROM contract_items ci WHERE ci.contract_id = c.id AND ci.is_recurring = true AND ci.churn_date IS NULL
					AND ci.renewed_by_item_id IS NULL AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')) AS end_date
			FROM contracts c LEFT JOIN clients cl ON cl.id = c.client_id
			WHERE c.id = ANY($1::uuid[]) AND c.holding_id = $2 AND c.deleted_at IS NULL`,
			[ids, holdingId, dto.auto_renew]
		)) as Row[];
		const byId = new Map(rows.map((row) => [String(row.id), row]));

		return ids.map((id) => {
			const row = byId.get(id);
			const liveItems = Number(row?.live_items ?? 0);
			const toChange = Number(row?.items_to_change ?? 0);
			const reason = !row
				? 'El contrato no existe en este holding'
				: toText(row.status) !== 'Activo'
					? `El contrato no está activo (${toText(row.status) ?? 'sin estado'})`
					: !liveItems
						? 'No tiene ítems recurrentes vigentes'
						: !toChange
							? `Ya tiene la renovación automática ${dto.auto_renew ? 'encendida' : 'apagada'}`
							: null;

			return {
				id,
				contract_number: toText(row?.contract_number),
				client_name: toText(row?.client_name),
				can_apply: !reason,
				skip_reason: reason,
				end_date: toText(row?.end_date)?.slice(0, 10) ?? null,
				items_to_change: toChange,
				current: !row || !liveItems ? null : Number(row.items_on) === liveItems ? 'on' : Number(row.items_on) > 0 ? 'partial' : 'off',
				items_on: Number(row?.items_on ?? 0),
				items_total: liveItems,
			};
		});
	}

	private async heads(ids: string[], holdingId: string): Promise<Map<string, Row>> {
		const rows = (await this.dataSource.query(
			`SELECT c.id, c.contract_number, c.status, c.contract_currency, cl.name_commercial AS client_name
			FROM contracts c LEFT JOIN clients cl ON cl.id = c.client_id
			WHERE c.id = ANY($1::uuid[]) AND c.holding_id = $2 AND c.deleted_at IS NULL`,
			[[...new Set(ids)], holdingId]
		)) as Row[];

		return new Map(rows.map((row) => [String(row.id), row]));
	}
}
