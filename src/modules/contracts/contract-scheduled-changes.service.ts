import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { holdingTimezone } from '@/core/utils/holding-preferences';

import { setApiWriter } from './api-writer';
import { todayFor } from './business-date';
import { PACT_KIND_LABELS } from './contract-alerts';
import { blockedPreview, type ChangeContext, type ChangePreview, planChange } from './contract-changes';
import { type ChangeApplyResult, ContractChangesService } from './contract-changes.service';
import { resolveUserId } from './contract-drafts.service';
import { deriveContractStatus } from './contract-status';
import { ContractsService } from './contracts.service';
import { codedValidationException } from './multicurrency';
import {
	insertScheduledChange,
	loadScheduledChanges,
	nextEffectiveOf,
	type PactItemRef,
	rowToScheduledChange,
	SCHEDULED_CHANGE_CODES,
	SCHEDULED_CHANGE_SELECT,
	scheduledChangeErrors,
	type ScheduledChangeRow,
	scheduledChangeToDto,
	type ScheduledChangeView,
} from './scheduled-change-rows';
import { pactApplication } from './scheduled-changes';

import type { ContractChangeRequestDto } from './dtos/contract-changes.dto';
import type {
	ApplyScheduledChangeDto,
	CreateScheduledChangeDto,
	ScheduledChangeReasonDto,
	UpdateScheduledChangeDto,
} from './dtos/contract-scheduled-changes.dto';

type Row = Record<string, unknown>;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_LABELS = PACT_KIND_LABELS;

/**
 * Ajustes pactados (R1, spec modificaciones §9.3.6): `GET/POST /contracts/:id/scheduled-changes`, `PATCH …/:changeId` (solo
 * `scheduled`), `POST …/:changeId/skip|cancel { reason }` y `POST …/:changeId/apply/preview|apply` (materializa con el motor de
 * `item_change` / `renewal`, `pactApplication`). Cada escritura en una transacción con `setApiWriter` primero y su evento
 * (`SCHEDULED_CHANGE_CREATED|UPDATED|SKIPPED|CANCELLED`); el aplicado es el evento normal del cambio (UPSELL/DOWNSELL subtipo
 * `price_step`/`index`, RENEWAL o RENEGOTIATION) con `applied_event_id` en la fila.
 */
const near = (a: unknown, b: unknown) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 1e-6;

/**
 * La vista previa de un cambio futuro se lee "cómo quedará" (Domi 13-11): el motor calcula el contrato a hoy, donde un cambio que rige
 * después todavía no mueve el MRR. Se ajusta la presentación, sin tocar el plan:
 * - MRR después = MRR de hoy + ΔMRR del cambio;
 * - el ajuste de un ítem renovado se muestra dentro de su renovación (una fila con el unitario nuevo), no como dos filas;
 * - no se listan como "ajustes" los ítems que solo quedan marcados como renovados (sin cambio de cantidad, precio ni fechas).
 */
export function readablePactPreview(ctx: ChangeContext, preview: ChangePreview): ChangePreview {
	const delta = Number(preview.rsm?.mrr_delta) || 0;
	const before = preview.contract.before;
	const after = { ...preview.contract.after, mrr: Math.round(((Number(before.mrr) || 0) + delta) * 100) / 100 };
	const children = preview.items.added.filter(
		(item) => (item.categoria === 'UPSELL' || item.categoria === 'DOWNSELL') && item.related_item_id?.startsWith('new:')
	);
	const added = preview.items.added
		.filter((item) => !children.includes(item))
		.map((item) => {
			const own = children.filter((child) => child.related_item_id === item.key);

			if (!own.length) return item;
			const monthly = own.reduce((sum, child) => sum + (Number(child.monthly_price) || 0), Number(item.monthly_price) || 0);
			const sameQuantity = own.every((child) => near(child.quantity, item.quantity));
			const quantity = Number(item.quantity) || 0;

			return {
				...item,
				monthly_price: Math.round(monthly * 100) / 100,
				unit_price: sameQuantity && quantity > 0 ? Math.round((monthly / quantity) * 1e6) / 1e6 : item.unit_price,
			};
		});
	const adjusted = preview.items.adjusted.filter((item) => {
		const current = ctx.items.find((row) => row.id === item.item_id);

		return !(
			current &&
			near(current.quantity, item.quantity) &&
			near(current.monthly_price, item.monthly_price) &&
			(current.start_date ?? null) === (item.start_date ?? null) &&
			(current.end_date ?? null) === (item.end_date ?? null)
		);
	});

	return { ...preview, contract: { ...preview.contract, after }, items: { ...preview.items, added, adjusted } };
}

/** Id del pacto en memoria de `createPreview` (no existe en la base). */
export const PREVIEW_PACT_ID = '00000000-0000-4000-8000-0000000000aa';

@Injectable()
export class ContractScheduledChangesService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly contracts: ContractsService,
		private readonly changes: ContractChangesService
	) {}

	/** `GET /contracts/:id/scheduled-changes`: todos los pactos del contrato (todos los estados). */
	async list(idOrNumber: string, holdingId: string): Promise<{ data: ScheduledChangeView[] }> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);

		return { data: await loadScheduledChanges(this.dataSource, contract.id, holdingId) };
	}

	/** `POST /contracts/:id/scheduled-changes`: pacto nuevo `scheduled` (borrador o vigente; nunca en un contrato Cancelado). */
	async create(idOrNumber: string, dto: CreateScheduledChangeDto, holdingId: string, authId: string): Promise<ScheduledChangeView> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.transaction(async (runner) => {
			const items = await this.openContractItems(runner, contract.id, holdingId);
			const itemId = dto.contract_item_id ?? (dto.item_key && UUID.test(dto.item_key) ? dto.item_key : null);
			const item = itemId ? (items.find((row) => row.id === itemId) ?? null) : null;
			const errors = scheduledChangeErrors(dto, 'body', item, Boolean(itemId || dto.item_key));

			if (errors.length) throw codedValidationException(errors);
			const id = await insertScheduledChange(runner, {
				contract_id: contract.id,
				holding_id: holdingId,
				contract_item_id: item?.id ?? null,
				dto,
				user_id: userId,
			});
			const view = await this.loadOne(runner, contract.id, id, holdingId);

			await this.insertEvent(runner, contract.id, holdingId, userId, 'SCHEDULED_CHANGE_CREATED', view, {
				title: 'Cambio programado',
				description: `Se programó ${KIND_LABELS[view.kind] ?? view.kind} (${view.value})${view.product_name ? ` de "${view.product_name}"` : ' del contrato'} ${this.when(view)}`,
			});

			return view;
		});
	}

	/**
	 * `POST /contracts/:id/scheduled-changes/preview`: qué hará el cambio futuro **antes de guardarlo** (Domi 13-11: la vista previa era un
	 * texto fijo). Mismo cuerpo que crear; arma el pacto en memoria y devuelve el `ChangePreview` del cambio que lo materializa (ítems antes
	 * y después, facturas por emitir afectadas, MRR, fecha efectiva real por ítem, bloqueos). No escribe nada. Índice todavía sin publicar →
	 * blocker `index_value_missing` (no se estima).
	 */
	async createPreview(idOrNumber: string, dto: CreateScheduledChangeDto, holdingId: string, today = new Date()): Promise<ChangePreview> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const iso = todayFor(await holdingTimezone(this.dataSource, holdingId), today);
		const probe = { effective_date: iso, change: { type: 'item_change' } } as ContractChangeRequestDto;
		const ctx = await this.changes.loadContext(this.dataSource, contract.id, holdingId, probe, iso);

		return this.previewFor(ctx, dto);
	}

	/** Simulación de un pacto todavía no guardado sobre un contexto ya cargado (la usa también el ajuste de precio en lote). */
	previewFor(ctx: ChangeContext, dto: CreateScheduledChangeDto): ChangePreview {
		const itemId = dto.contract_item_id ?? (dto.item_key && UUID.test(dto.item_key) ? dto.item_key : null);
		const item = itemId ? (ctx.items.find((row) => row.id === itemId) ?? null) : null;
		const errors = scheduledChangeErrors(
			dto,
			'body',
			item ? { ...item, is_recurring: item.is_recurring !== false } : null,
			Boolean(itemId || dto.item_key)
		);

		if (errors.length) throw codedValidationException(errors);
		const pact: ScheduledChangeRow = {
			id: PREVIEW_PACT_ID,
			contract_item_id: item?.id ?? null,
			group_key: null,
			parent_id: null,
			trigger: dto.trigger,
			effective_date: dto.effective_date ?? null,
			anchor_date: dto.anchor_date ?? null,
			interval_months: dto.interval_months ?? null,
			next_effective_date: nextEffectiveOf(dto),
			kind: dto.kind,
			value: Number(dto.value),
			index_code: dto.index_code ?? null,
			index_base_date: dto.index_base_date ?? null,
			index_base_value: dto.index_base_value ?? null,
			index_lag_months: dto.index_lag_months ?? 1,
			rounding: dto.rounding ?? 'unit_2',
			status: 'scheduled',
		};
		const simulated = { ...ctx, scheduled_changes: [...(ctx.scheduled_changes ?? []), pact as ScheduledChangeView] };
		const { request, options, blockers } = pactApplication(simulated, pact, {});

		if (blockers.length) return blockedPreview(simulated, request, blockers);

		return readablePactPreview(simulated, planChange(simulated, request, options).preview);
	}

	/** `PATCH …/:changeId`: edita un pacto `scheduled` (409 `scheduled_change_not_editable` si ya se aplicó, omitió o canceló). */
	async update(
		idOrNumber: string,
		changeId: string,
		dto: UpdateScheduledChangeDto,
		holdingId: string,
		authId: string
	): Promise<ScheduledChangeView> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.transaction(async (runner) => {
			await runner.query(`SELECT id FROM contract_scheduled_changes WHERE id = $1 AND holding_id = $2 FOR UPDATE`, [changeId, holdingId]);
			const current = await this.loadScheduled(runner, contract.id, changeId, holdingId);
			const items = await this.openContractItems(runner, contract.id, holdingId);
			const merged: CreateScheduledChangeDto = { ...scheduledChangeToDto(current), ...dto, item_key: undefined };
			const itemId = dto.contract_item_id !== undefined ? dto.contract_item_id : current.contract_item_id;
			const item = itemId ? (items.find((row) => row.id === itemId) ?? null) : null;
			const errors = scheduledChangeErrors(merged, 'body', item, Boolean(itemId));

			if (errors.length) throw codedValidationException(errors);
			await runner.query(
				`UPDATE contract_scheduled_changes SET contract_item_id = $4, group_key = $5, trigger = $6, effective_date = $7, anchor_date = $8,
					interval_months = $9, next_effective_date = $10, kind = $11, value = $12, index_code = $13, index_base_date = $14,
					index_base_value = $15, index_lag_months = $16, rounding = $17, notes = $18
				WHERE id = $1 AND contract_id = $2 AND holding_id = $3 AND status = 'scheduled'`,
				[
					changeId,
					contract.id,
					holdingId,
					item?.id ?? null,
					merged.group_key ?? null,
					merged.trigger,
					merged.effective_date ?? null,
					merged.anchor_date ?? null,
					merged.interval_months ?? null,
					merged.trigger === 'on_date'
						? merged.effective_date
						: merged.trigger === 'every_n_months'
							? current.next_effective_date && current.trigger === 'every_n_months' && merged.anchor_date === current.anchor_date
								? current.next_effective_date
								: merged.anchor_date
							: null,
					merged.kind,
					merged.value,
					merged.index_code ?? null,
					merged.index_base_date ?? null,
					merged.index_base_value ?? null,
					merged.index_lag_months ?? 1,
					merged.rounding ?? 'unit_2',
					merged.notes ?? null,
				]
			);
			const view = await this.loadOne(runner, contract.id, changeId, holdingId);

			await this.insertEvent(runner, contract.id, holdingId, userId, 'SCHEDULED_CHANGE_UPDATED', view, {
				title: 'Cambio programado editado',
				description: `Se editó el cambio programado ${KIND_LABELS[view.kind] ?? view.kind} (${view.value}) ${this.when(view)}`,
				before: current,
			});

			return view;
		});
	}

	/**
	 * `POST …/:changeId/skip { reason }`: no se aplica en esta ocasión. `every_n_months` = se omite solo la próxima (hija `skipped`, la madre
	 * avanza un intervalo); el resto queda `skipped`.
	 */
	async skip(idOrNumber: string, changeId: string, dto: ScheduledChangeReasonDto, holdingId: string, authId: string) {
		return await this.close(idOrNumber, changeId, dto.reason, holdingId, authId, 'skipped');
	}

	/** `POST …/:changeId/cancel { reason }`: retira el pacto antes de aplicarse (`cancelled`). */
	async cancel(idOrNumber: string, changeId: string, dto: ScheduledChangeReasonDto, holdingId: string, authId: string) {
		return await this.close(idOrNumber, changeId, dto.reason, holdingId, authId, 'cancelled');
	}

	/** `POST …/:changeId/apply/preview`: el preview del cambio que materializa el pacto (mismo cálculo que aplicar). */
	async applyPreview(
		idOrNumber: string,
		changeId: string,
		dto: ApplyScheduledChangeDto,
		holdingId: string,
		today = new Date()
	): Promise<ChangePreview> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const { request, options, blockers, ctx } = await this.application(contract.id, changeId, dto, holdingId, today);

		if (blockers.length) return blockedPreview(ctx, request, blockers);

		return await this.changes.preview(contract.id, request, holdingId, today, options);
	}

	/** `POST …/:changeId/apply`: aplica el cambio del pacto en una transacción (409 `blocked` con el preview si hay bloqueos). */
	async apply(
		idOrNumber: string,
		changeId: string,
		dto: ApplyScheduledChangeDto,
		holdingId: string,
		authId: string,
		idempotencyKey?: string,
		today = new Date()
	): Promise<ChangeApplyResult> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const { request, options, blockers, ctx } = await this.application(contract.id, changeId, dto, holdingId, today);

		if (blockers.length) {
			const preview = blockedPreview(ctx, request, blockers);

			throw new ConflictException({
				message: `No se puede aplicar el cambio programado: ${blockers.map((blocker) => blocker.message).join('; ')}`,
				code: 'blocked',
				preview,
			});
		}

		return await this.changes.apply(contract.id, request, holdingId, authId, idempotencyKey, today, options);
	}

	/**
	 * `POST …/:changeId/revert/preview`: qué deshace revertir un cambio programado ya aplicado (ítem de ajuste que se quita, Por Emitir que
	 * cambian, emitidas que se anulan con su NC espejo y Por Emitir nuevas sin el ajuste). No escribe.
	 */
	async revertPreview(
		idOrNumber: string,
		changeId: string,
		dto: ScheduledChangeReasonDto,
		holdingId: string,
		today = new Date()
	): Promise<ChangePreview> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const { request, options } = await this.reversal(contract.id, changeId, dto.reason, holdingId, today);

		return await this.changes.preview(contract.id, request, holdingId, today, options);
	}

	/**
	 * `POST …/:changeId/revert { reason }` (usuarias 13-11): deshace un cambio programado aplicado, también si ya se facturó, sin registrar un
	 * downsell (`planScheduledChangeRevert`). El cambio queda `cancelled` con motivo "Revertido: …"; evento `SCHEDULED_CHANGE_REVERTED`.
	 * 409 `blocked` con el preview si algo lo impide (período cerrado, factura pagada o con documento electrónico…).
	 */
	async revert(
		idOrNumber: string,
		changeId: string,
		dto: ScheduledChangeReasonDto,
		holdingId: string,
		authId: string,
		idempotencyKey?: string,
		today = new Date()
	): Promise<ChangeApplyResult> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const { request, options } = await this.reversal(contract.id, changeId, dto.reason, holdingId, today);

		return await this.changes.apply(contract.id, request, holdingId, authId, idempotencyKey, today, options);
	}

	// ---------------------------------------------------------------- internos

	/** Pedido y opciones de la reversión: el cambio, el evento que lo aplicó y los ítems que creó esa aplicación (`metadata.created_items`). */
	private async reversal(contractId: string, changeId: string, reason: string, holdingId: string, today: Date) {
		const [row] = (await this.dataSource.query(
			`SELECT sc.id, sc.applied_event_id, e.metadata->'created_items' AS created_items
			FROM contract_scheduled_changes sc
			LEFT JOIN contract_lifecycle_events e ON e.id = sc.applied_event_id AND e.holding_id = sc.holding_id
			WHERE sc.id = $1 AND sc.contract_id = $2 AND sc.holding_id = $3`,
			[changeId, contractId, holdingId]
		)) as Row[];

		if (!row) throw new NotFoundException('Cambio programado no encontrado');
		const created = row.created_items && typeof row.created_items === 'object' ? Object.values(row.created_items as Row) : [];
		const iso = todayFor(await holdingTimezone(this.dataSource, holdingId), today);
		const request = {
			effective_date: iso,
			origin: { type: 'manual' },
			reason: reason.trim(),
			change: { type: 'scheduled_change_revert' },
		} as ContractChangeRequestDto;

		return {
			request,
			options: { revert: { scheduled_change_id: changeId, event_id: toText(row.applied_event_id), item_ids: created.map((id) => String(id)) } },
		};
	}

	private async application(contractId: string, changeId: string, dto: ApplyScheduledChangeDto, holdingId: string, today: Date) {
		const pact = await this.loadScheduled(this.dataSource, contractId, changeId, holdingId);
		const iso = todayFor(await holdingTimezone(this.dataSource, holdingId), today);
		const probe = { effective_date: dto.effective_date ?? iso, change: { type: 'item_change' } } as ContractChangeRequestDto;
		const ctx = await this.changes.loadContext(this.dataSource, contractId, holdingId, probe, iso);
		const application = pactApplication(ctx, pact, dto);

		return { ...application, ctx };
	}

	private async close(
		idOrNumber: string,
		changeId: string,
		reason: string,
		holdingId: string,
		authId: string,
		status: 'skipped' | 'cancelled'
	): Promise<ScheduledChangeView> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);
		const view = await this.closeInTransaction(contract.id, changeId, reason, holdingId, userId, status);

		// Notificaciones v2: omitir o cancelar el pacto cierra su alerta "Cambio programado por aplicar".
		await this.changes.closeResolvedAlerts(contract.id, holdingId);

		return view;
	}

	private async closeInTransaction(
		contractId: string,
		changeId: string,
		reason: string,
		holdingId: string,
		userId: string,
		status: 'skipped' | 'cancelled'
	): Promise<ScheduledChangeView> {
		const contract = { id: contractId };

		return await this.transaction(async (runner) => {
			await runner.query(`SELECT id FROM contract_scheduled_changes WHERE id = $1 AND holding_id = $2 FOR UPDATE`, [changeId, holdingId]);
			const current = await this.loadScheduled(runner, contract.id, changeId, holdingId);

			if (status === 'skipped' && current.trigger === 'every_n_months') {
				const date = current.next_effective_date ?? current.anchor_date;

				await runner.query(
					`INSERT INTO contract_scheduled_changes (
						holding_id, contract_id, contract_item_id, group_key, parent_id, trigger, effective_date, kind, value, status, status_reason,
						status_changed_by, origin, created_by
					) VALUES ($1, $2, $3, $4, $5, 'every_n_months', $6, $7, $8, 'skipped', $9, $10, $11::jsonb, $10)`,
					[
						holdingId,
						contract.id,
						current.contract_item_id,
						current.group_key,
						current.id,
						date,
						current.kind,
						current.value,
						reason,
						userId,
						JSON.stringify({ type: 'scheduled_change', parent_id: current.id }),
					]
				);
				await runner.query(
					`UPDATE contract_scheduled_changes SET next_effective_date = (COALESCE(next_effective_date, anchor_date) + make_interval(months => interval_months))::date
					WHERE id = $1 AND holding_id = $2`,
					[changeId, holdingId]
				);
			} else {
				await runner.query(
					`UPDATE contract_scheduled_changes SET status = $4, status_reason = $5, status_changed_by = $6
					WHERE id = $1 AND contract_id = $2 AND holding_id = $3 AND status = 'scheduled'`,
					[changeId, contract.id, holdingId, status, reason, userId]
				);
			}
			const view = await this.loadOne(runner, contract.id, changeId, holdingId);

			await this.insertEvent(
				runner,
				contract.id,
				holdingId,
				userId,
				status === 'skipped' ? 'SCHEDULED_CHANGE_SKIPPED' : 'SCHEDULED_CHANGE_CANCELLED',
				view,
				{
					title: status === 'skipped' ? 'Cambio programado omitido' : 'Cambio programado cancelado',
					description: `${status === 'skipped' ? 'Se omitió' : 'Se canceló'} el cambio programado ${KIND_LABELS[view.kind] ?? view.kind} (${view.value}): ${reason}`,
					reason,
				}
			);

			return view;
		});
	}

	private when(view: ScheduledChangeView) {
		return view.trigger === 'on_renewal'
			? 'al renovar'
			: view.trigger === 'on_date'
				? `el ${view.effective_date}`
				: `cada ${view.interval_months} meses desde el ${view.anchor_date}`;
	}

	/** Ítems del contrato abierto a pactos (bloquea el contrato; 409 si está Cancelado). */
	private async openContractItems(runner: QueryRunner, contractId: string, holdingId: string): Promise<PactItemRef[]> {
		const [contract] = (await runner.query(`SELECT status FROM contracts WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL FOR UPDATE`, [
			contractId,
			holdingId,
		])) as Row[];

		if (!contract) throw new NotFoundException('Contrato no encontrado');
		const rows = (await runner.query(
			`SELECT id, product_name, is_recurring, churn_date::text AS churn_date, renewed_by_item_id, categoria, end_date::text AS end_date
			FROM contract_items WHERE contract_id = $1 AND holding_id = $2`,
			[contractId, holdingId]
		)) as Row[];
		const status = deriveContractStatus(
			toText(contract.status),
			rows.map((row) => ({
				is_recurring: row.is_recurring !== false,
				categoria: toText(row.categoria),
				churn_date: toText(row.churn_date),
				end_date: toText(row.end_date),
				renewed_by_item_id: toText(row.renewed_by_item_id),
			})),
			todayFor(await holdingTimezone(this.dataSource, holdingId))
		);

		if (status === 'cancelled' || status === 'other')
			throw new ConflictException({
				message: 'El contrato está cancelado: no admite ajustes pactados (reactívalo primero)',
				code: SCHEDULED_CHANGE_CODES.contract_not_open,
			});

		return rows.map((row) => ({
			id: String(row.id),
			product_name: toText(row.product_name),
			is_recurring: row.is_recurring !== false,
			churn_date: toText(row.churn_date),
			renewed_by_item_id: toText(row.renewed_by_item_id),
			categoria: toText(row.categoria),
		}));
	}

	private async loadOne(db: Pick<DataSource, 'query'> | QueryRunner, contractId: string, id: string, holdingId: string) {
		const [row] = (await db.query(`${SCHEDULED_CHANGE_SELECT} WHERE sc.id = $1 AND sc.contract_id = $2 AND sc.holding_id = $3`, [
			id,
			contractId,
			holdingId,
		])) as Row[];

		if (!row) throw new NotFoundException({ message: 'El cambio programado no existe en este contrato', code: SCHEDULED_CHANGE_CODES.not_found });

		return rowToScheduledChange(row);
	}

	/** Pacto `scheduled` del contrato (bloqueado si hay transacción); 409 `scheduled_change_not_editable` en otro estado. */
	private async loadScheduled(db: Pick<DataSource, 'query'> | QueryRunner, contractId: string, id: string, holdingId: string) {
		const view = await this.loadOne(db, contractId, id, holdingId);

		if (view.status !== 'scheduled')
			throw new ConflictException({
				message: `El cambio programado está ${view.status === 'applied' ? 'aplicado' : view.status === 'skipped' ? 'omitido' : 'cancelado'}: ya no se edita ni se aplica`,
				code: SCHEDULED_CHANGE_CODES.not_editable,
			});

		return view;
	}

	private async insertEvent(
		runner: QueryRunner,
		contractId: string,
		holdingId: string,
		userId: string,
		type: string,
		view: ScheduledChangeView,
		extra: { title: string; description: string; before?: ScheduledChangeView; reason?: string }
	) {
		await runner.query(
			`INSERT INTO contract_lifecycle_events (
				contract_id, holding_id, event_type, event_status, title, description, summary, created_by, completed_at, effective_date,
				amount_delta, items_affected, metadata
			) VALUES ($1, $2, $3, 'Completed', $4, $5, $5, $6, now(), CURRENT_DATE, 0, $7::jsonb, $8::jsonb)`,
			[
				contractId,
				holdingId,
				type,
				extra.title,
				extra.description,
				userId,
				JSON.stringify(view.contract_item_id ? [view.contract_item_id] : []),
				JSON.stringify({
					source: 'api_v2',
					scheduled_change_id: view.id,
					trigger: view.trigger,
					kind: view.kind,
					value: view.value,
					status: view.status,
					reason: extra.reason ?? null,
					...(extra.before ? { before: extra.before, after: view } : {}),
				}),
			]
		);
	}

	private async transaction<T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> {
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		try {
			// Costura `sapira.writer = 'api'`: primera sentencia de la transacción.
			await setApiWriter(runner);
			const result = await work(runner);

			await runner.commitTransaction();

			return result;
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}
	}
}
