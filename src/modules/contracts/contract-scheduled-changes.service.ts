import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { setApiWriter } from './api-writer';
import { blockedPreview, type ChangePreview } from './contract-changes';
import { type ChangeApplyResult, ContractChangesService } from './contract-changes.service';
import { resolveUserId } from './contract-drafts.service';
import { deriveContractStatus } from './contract-status';
import { ContractsService } from './contracts.service';
import { codedValidationException } from './multicurrency';
import {
	insertScheduledChange,
	loadScheduledChanges,
	type PactItemRef,
	rowToScheduledChange,
	SCHEDULED_CHANGE_CODES,
	SCHEDULED_CHANGE_SELECT,
	scheduledChangeErrors,
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
const KIND_LABELS: Record<string, string> = {
	percent_uplift: 'reajuste %',
	index: 'reajuste por índice',
	new_unit_price: 'precio nuevo',
	quantity: 'cantidad nueva',
	term: 'plazo nuevo',
	billing_frequency: 'frecuencia nueva',
};

/**
 * Ajustes pactados (R1, spec modificaciones §9.3.6): `GET/POST /contracts/:id/scheduled-changes`, `PATCH …/:changeId` (solo
 * `scheduled`), `POST …/:changeId/skip|cancel { reason }` y `POST …/:changeId/apply/preview|apply` (materializa con el motor de
 * `item_change` / `renewal`, `pactApplication`). Cada escritura en una transacción con `setApiWriter` primero y su evento
 * (`SCHEDULED_CHANGE_CREATED|UPDATED|SKIPPED|CANCELLED`); el aplicado es el evento normal del cambio (UPSELL/DOWNSELL subtipo
 * `price_step`/`index`, RENEWAL o RENEGOTIATION) con `applied_event_id` en la fila.
 */
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
				title: 'Ajuste pactado',
				description: `Se pactó ${KIND_LABELS[view.kind] ?? view.kind} (${view.value})${view.product_name ? ` de "${view.product_name}"` : ' del contrato'} ${this.when(view)}`,
			});

			return view;
		});
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
				title: 'Ajuste pactado editado',
				description: `Se editó el pacto ${KIND_LABELS[view.kind] ?? view.kind} (${view.value}) ${this.when(view)}`,
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
				message: `No se puede aplicar el pacto: ${blockers.map((blocker) => blocker.message).join('; ')}`,
				code: 'blocked',
				preview,
			});
		}

		return await this.changes.apply(contract.id, request, holdingId, authId, idempotencyKey, today, options);
	}

	// ---------------------------------------------------------------- internos

	private async application(contractId: string, changeId: string, dto: ApplyScheduledChangeDto, holdingId: string, today: Date) {
		const pact = await this.loadScheduled(this.dataSource, contractId, changeId, holdingId);
		const iso = today.toISOString().slice(0, 10);
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
					title: status === 'skipped' ? 'Ajuste pactado omitido' : 'Ajuste pactado cancelado',
					description: `${status === 'skipped' ? 'Se omitió' : 'Se canceló'} el pacto ${KIND_LABELS[view.kind] ?? view.kind} (${view.value}): ${reason}`,
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
			new Date().toISOString().slice(0, 10)
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

		if (!row) throw new NotFoundException({ message: 'El pacto no existe en este contrato', code: SCHEDULED_CHANGE_CODES.not_found });

		return rowToScheduledChange(row);
	}

	/** Pacto `scheduled` del contrato (bloqueado si hay transacción); 409 `scheduled_change_not_editable` en otro estado. */
	private async loadScheduled(db: Pick<DataSource, 'query'> | QueryRunner, contractId: string, id: string, holdingId: string) {
		const view = await this.loadOne(db, contractId, id, holdingId);

		if (view.status !== 'scheduled')
			throw new ConflictException({
				message: `El pacto está ${view.status === 'applied' ? 'aplicado' : view.status === 'skipped' ? 'omitido' : 'cancelado'}: ya no se edita ni se aplica`,
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
