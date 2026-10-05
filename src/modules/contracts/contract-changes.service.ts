import { createHash, randomUUID } from 'crypto';

import { ConflictException, HttpException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { holdingTimezone } from '@/core/utils/holding-preferences';
import { validationException } from '@/core/utils/validation-errors';
import { insertClientEntity } from '@/modules/clients/client-entity-writer';
import { NotificationsService } from '@/modules/notifications/notifications.service';

import { setApiWriter } from './api-writer';
import {
	contractFxNeedsRefresh,
	invoiceTermsSql,
	mirrorInvoiceSystemAmounts,
	pricingFields,
	refreshContractSystemFx,
	refreshInvoiceSystemAmounts,
	syncContractTerm,
} from './api-written-fields';
import { type FxPeriodRate, normalizeCountry, normalizeTaxRate, round2 } from './billing-engine';
import { todayFor } from './business-date';
import { catalogPriceIds, loadCatalogPrices } from './catalog-prices';
import { headerAmounts } from './consumption';
import { creditNoteStatusFor, PENDING_STATUS, voidedSql } from './contract-360';
import { insertEngineInvoices, insertEngineLines, type InvoiceIssuer, type InvoiceLineUnits } from './contract-activation.service';
import { reconcileContractAlerts } from './contract-alerts';
import {
	type ChangeContext,
	type ChangeContractRow,
	type ChangeInvoiceLineRow,
	type ChangeInvoiceRow,
	type ChangeItemRow,
	type ChangePlan,
	type ChangePreview,
	type ContractFxRateRow,
	type ItemPauseRow,
	mirrorCreditNoteAmounts,
	NEW_ENTITY_KEY,
	planChange,
	planHorizonExtension,
	type PlanOptions,
	validateChangeRequest,
	type WriteOp,
} from './contract-changes';
import { cleanPaymentTerms, QUOTE_CONTRACT_CREATED_STAGE, resolveUserId } from './contract-drafts.service';
import { ContractInvoiceDescriptionsService } from './contract-invoice-descriptions.service';
import { ContractInvoiceEditService, type PendingTermsPlan } from './contract-invoice-edit.service';
import { ContractsService } from './contracts.service';
import { parseStoredTemplate } from './invoice-description';
import { type ContractConversion, itemRate, multicurrencyHeader, upperCode } from './multicurrency';
import { PRICE_COLUMNS, priceSpecFromRow } from './price-rows';
import { DEFAULT_INVOICE_LINE_MODE, type PricedSubline } from './pricing-engine';
import { loadScheduledChanges } from './scheduled-change-rows';
import { DESCRIPTION_LIMITS_SQL, descriptionMaxCharsOfRow } from './tax-document-types';

import type { ContractChangeRequestDto } from './dtos/contract-changes.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
const round6 = (value: number) => Math.round(value * 1e6) / 1e6 || 0;
const parseJson = (value: unknown) => (typeof value === 'string' ? (JSON.parse(value) as unknown) : value);
/**
 * Avisos que solo informan lo que el cambio hace (no son un riesgo que justificar): no piden motivo. `pending_descriptions_updated` =
 * `item_update` (§9.2, corregir un dato) regenera la glosa de las Por Emitir del ítem con los datos corregidos.
 */
export const INFORMATIVE_WARNINGS: ReadonlySet<string> = new Set(['pending_descriptions_updated']);
/** Origen de las líneas y NC que crean las modificaciones. */
export const CHANGES_FX_RATE_SOURCE = 'contract-change';
export { creditNoteStatusFor } from './contract-360';

/**
 * Líneas de las NC de descuento vigentes (`credit_type = 'discount'`, activas, no Canceladas) de las facturas del contrato, con la factura que
 * acreditan: misma regla que `PREVIOUS_DISCOUNTS_SQL` de la NC de descuento del 360, para todo el contrato de una vez.
 */
export const CONTRACT_PREVIOUS_DISCOUNTS_SQL = `SELECT nc.related_invoice_id, nii.contract_item_id,
		nii.billing_period_start::text AS billing_period_start, nii.billing_period_end::text AS billing_period_end, nii.subtotal_contract_currency
	FROM invoices nc JOIN invoice_items nii ON nii.invoice_id = nc.id
	WHERE nc.contract_id = $1 AND nc.holding_id = $2 AND nc.document_type = 'NC' AND nc.credit_type = 'discount'
		AND nc.is_active = true AND nc.status IS DISTINCT FROM 'Cancelada' AND nc.related_invoice_id IS NOT NULL`;

/**
 * Atribuye lo ya acreditado por NC de descuento a cada línea de la emitida (mismo ítem y período contenido en el de la línea; la NC de una
 * modificación arranca en su fecha efectiva): `previously_credited` en moneda de contrato, positivo.
 */
export function assignPreviousCredits(invoices: ChangeInvoiceRow[], rows: Row[]): void {
	const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));

	for (const row of rows) {
		const invoice = byId.get(String(row.related_invoice_id));

		if (!invoice) continue;
		const itemId = toText(row.contract_item_id);
		const start = toText(row.billing_period_start)?.slice(0, 10) ?? null;
		const end = toText(row.billing_period_end)?.slice(0, 10) ?? null;
		const line = invoice.lines.find(
			(candidate) =>
				candidate.contract_item_id === itemId &&
				(!start || !candidate.billing_period_start || start >= candidate.billing_period_start) &&
				(!end || !candidate.billing_period_end || end <= candidate.billing_period_end)
		);

		if (line) line.previously_credited = round2((line.previously_credited ?? 0) + Math.abs(toNumber(row.subtotal_contract_currency)));
	}
}

/** ¿Cambió `total_value` entre la fila antes y después del UPDATE del contrato? */
export const totalValueChanged = (before: Row | undefined, after: Row | undefined): boolean =>
	Boolean(before && after) && toNullableNumber(before!.total_value) !== toNullableNumber(after!.total_value);

/** Huella del pedido para la idempotencia: JSON con claves ordenadas → sha256. Misma clave con otro cuerpo → 409 `idempotency_conflict`. */
export function requestHash(dto: unknown): string {
	const stable = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(stable)
			: value && typeof value === 'object'
				? Object.fromEntries(
						Object.keys(value as Row)
							.filter((key) => (value as Row)[key] !== undefined)
							.sort()
							.map((key) => [key, stable((value as Row)[key])])
					)
				: value;

	return createHash('sha256')
		.update(JSON.stringify(stable(dto)))
		.digest('hex');
}

/** Lo que crea el cambio: ítems (clave → id), facturas, NC, razón social nueva (§9.3.10) y pactos aplicados (§9.3.4/§9.3.6). */
export interface ChangeCreated {
	items: Record<string, string>;
	invoices: string[];
	credit_notes: string[];
	entity_id?: string | null;
	scheduled_changes?: string[];
	/** `pause` (§9.3.3): filas nuevas de `contract_item_pauses` (se ligan al evento con `pause_event_id`). */
	pauses?: string[];
	/** `resume` (§9.3.3): pausas cerradas (se ligan al evento con `resume_event_id`). */
	resumed_pauses?: string[];
}

export interface ChangeApplyResult extends ChangePreview {
	applied: boolean;
	idempotent: boolean;
	event_id: string | null;
	created: ChangeCreated;
	/** Contrato 360 después del cambio (`GET /contracts/:id`). */
	detail: unknown;
}

/**
 * Contratos v2 — modificaciones con vista previa (`docs/v2-rediseno/spec-modificaciones-contrato-v2.md` §4).
 *
 * `POST /contracts/:id/changes/preview` calcula sin escribir; `POST /contracts/:id/changes` aplica en **una transacción**
 * con el mismo cálculo (`planChange`): (1) `SELECT … FOR UPDATE` del contrato, (2) estado, fechas y period guard como
 * bloqueos explicados, (3) ítems con categoría, fin y precios explícitos, (4) facturas por cambio mínimo (solo Por Emitir
 * activas; emitidas → NC espejo), (5) `revenue_schedule_rebuild(contrato, mes efectivo)`, (6) encabezado del contrato,
 * (7) evento con before/after (+ etapa de la cotización si es el origen), (8) respuesta = preview + `applied: true` + 360.
 * Abre la transacción con `setApiWriter` (costura `sapira.writer = 'api'`): los triggers legacy no corren y la API escribe
 * cada campo (precios del ítem, `contracts.term`, FX del contrato y de las facturas, grupo y condiciones de las facturas).
 */
@Injectable()
export class ContractChangesService {
	private readonly logger = new Logger(ContractChangesService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly contracts: ContractsService,
		private readonly invoiceEdit: ContractInvoiceEditService,
		private readonly descriptions: ContractInvoiceDescriptionsService,
		@Optional() private readonly notifications?: NotificationsService
	) {}

	// ---------------------------------------------------------------- vista previa

	/** `POST /contracts/:id/changes/preview`: no escribe nada. */
	async preview(
		idOrNumber: string,
		dto: ContractChangeRequestDto,
		holdingId: string,
		today = new Date(),
		options: PlanOptions = {}
	): Promise<ChangePreview> {
		validateChangeRequest(dto);
		const resolved = await this.contracts.resolveContract(idOrNumber, holdingId);
		const ctx = await this.loadContext(
			this.dataSource,
			resolved.id,
			holdingId,
			dto,
			todayFor(await holdingTimezone(this.dataSource, holdingId), today)
		);
		const plan = planChange(ctx, dto, options);

		await this.planPendingTerms(this.dataSource, ctx, dto, plan, holdingId, false);

		return plan.preview;
	}

	/**
	 * `billing_conditions` con `apply_to_pending`: el texto nuevo también va a las Por Emitir desde la fecha efectiva (mismas reglas que el
	 * masivo de facturas). Completa el preview (`pending_terms` + avisos) y el evento del cambio; null si no aplica.
	 */
	private async planPendingTerms(
		db: Queryable,
		ctx: ChangeContext,
		dto: ContractChangeRequestDto,
		plan: ChangePlan,
		holdingId: string,
		lock: boolean
	): Promise<PendingTermsPlan | null> {
		if (dto.change.type !== 'billing_conditions' || dto.change.apply_to_pending !== true) return null;
		const set = plan.ops.find((op): op is Extract<WriteOp, { kind: 'update_contract' }> => op.kind === 'update_contract')?.set;

		// El plan ya rechazó (400) `apply_to_pending` sin cambio de condiciones.
		if (!set || !('invoice_terms_and_conditions' in set)) return null;
		const terms = await this.invoiceEdit.planPendingTerms(
			db,
			ctx.contract.id,
			holdingId,
			toText(set.invoice_terms_and_conditions),
			plan.preview.effective_date,
			ctx.today,
			lock
		);
		const updated = terms.updated.length;

		plan.preview.pending_terms = { updated: terms.updated, skipped: terms.skipped };
		if (updated)
			plan.preview.warnings.push({
				code: 'pending_invoices_updated',
				message: `${updated} ${updated === 1 ? 'factura por emitir tomará' : 'facturas por emitir tomarán'} los términos nuevos`,
			});
		if (terms.skipped.length)
			plan.preview.warnings.push({
				code: 'pending_invoices_skipped',
				message: `${terms.skipped.length} factura(s) por emitir conservan sus términos: ${terms.skipped
					.map((skip) => `${skip.invoice_number ?? skip.invoice_id} (${skip.message})`)
					.join('; ')}`,
			});

		return terms;
	}

	// ---------------------------------------------------------------- aplicar

	/** `POST /contracts/:id/changes`: una transacción; 409 con el preview si hay bloqueos; `Idempotency-Key` opcional (Supuesto 5). */
	async apply(
		idOrNumber: string,
		dto: ContractChangeRequestDto,
		holdingId: string,
		authId: string,
		idempotencyKey?: string,
		today = new Date(),
		options: PlanOptions = {}
	): Promise<ChangeApplyResult> {
		validateChangeRequest(dto);
		const resolved = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);
		const key = idempotencyKey?.trim() || null;
		// "Hoy" del holding en su zona (ronda 4 de Configuración), leído antes de abrir la transacción.
		const day = todayFor(await holdingTimezone(this.dataSource, holdingId), today);
		const runner = this.dataSource.createQueryRunner();
		let active = false;

		await runner.connect();
		await runner.startTransaction();
		active = true;
		try {
			// Costura `sapira.writer = 'api'`: primera sentencia de la transacción (los triggers legacy no corren para la API).
			await setApiWriter(runner);
			await runner.query(`SELECT id FROM contracts WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL FOR UPDATE`, [
				resolved.id,
				holdingId,
			]);
			if (key) {
				const [previous] = (await runner.query(
					`SELECT id, metadata FROM contract_lifecycle_events WHERE contract_id = $1 AND holding_id = $2 AND metadata->>'idempotency_key' = $3 LIMIT 1`,
					[resolved.id, holdingId, key]
				)) as Row[];

				if (previous) {
					await runner.rollbackTransaction();
					active = false;
					const metadata = (parseJson(previous.metadata) ?? {}) as Row;
					const storedHash = toText(metadata.request_hash);

					// Misma clave con otro cuerpo: no es un reintento, es otro pedido (409, no se aplica ni se devuelve el anterior).
					if (storedHash && storedHash !== requestHash(dto)) {
						throw new ConflictException({
							message: 'La clave de idempotencia ya se usó con otro pedido: genera una clave nueva para este cambio',
							code: 'idempotency_conflict',
							event_id: String(previous.id),
						});
					}
					const created = {
						items: (metadata.created_items as Record<string, string> | undefined) ?? {},
						invoices: (metadata.created_invoices as string[] | undefined) ?? [],
						credit_notes: (metadata.created_credit_notes as string[] | undefined) ?? [],
						entity_id: (metadata.created_entity_id as string | null | undefined) ?? null,
						scheduled_changes: (metadata.scheduled_changes_applied as string[] | undefined) ?? [],
						pauses: (metadata.created_pauses as string[] | undefined) ?? [],
						resumed_pauses: (metadata.resumed_pauses as string[] | undefined) ?? [],
					};
					// La respuesta repite el preview guardado al aplicar (eventos anteriores sin preview: el contrato actual sin reglas).
					const stored = metadata.preview as ChangePreview | undefined;
					const preview =
						stored ?? this.previewWithoutRules(await this.loadContext(this.dataSource, resolved.id, holdingId, dto, day), dto);

					return {
						...preview,
						warnings: [
							...(stored?.warnings ?? []),
							{ code: 'idempotent', message: 'La clave de idempotencia ya estaba registrada: no se modificó nada' },
						],
						applied: true,
						idempotent: true,
						event_id: String(previous.id),
						created,
						detail: await this.contracts.detail(resolved.id, holdingId),
					};
				}
			}
			const ctx = await this.loadContext(runner, resolved.id, holdingId, dto, day);
			const plan = planChange(ctx, dto, options);
			const pendingTerms = await this.planPendingTerms(runner, ctx, dto, plan, holdingId, true);

			if (!plan.preview.can_apply) {
				await runner.rollbackTransaction();
				active = false;
				throw new ConflictException({
					message: `No se puede aplicar el cambio: ${plan.preview.blockers.map((blocker) => blocker.message).join('; ')}`,
					code: 'blocked',
					preview: plan.preview,
				});
			}
			// Las advertencias son blandas: piden motivo y siguen (flexibilidad con trazabilidad). Las informativas no piden motivo.
			if (plan.preview.warnings.some((warning) => !INFORMATIVE_WARNINGS.has(warning.code)) && !dto.reason?.trim() && !dto.notes?.trim()) {
				await runner.rollbackTransaction();
				active = false;
				throw validationException([
					{
						field: 'reason',
						message: `Hay advertencias (${plan.preview.warnings.map((warning) => warning.code).join(', ')}): escribe el motivo para continuar`,
					},
				]);
			}
			const created = await this.execute(runner, ctx, plan, holdingId, userId);

			// Términos a las Por Emitir: después del encabezado del contrato, misma transacción (ya con `setApiWriter`).
			if (pendingTerms) {
				const bulkId = randomUUID();
				const invoiceEventIds = await this.invoiceEdit.applyPendingTerms(
					runner,
					ctx.contract.id,
					holdingId,
					userId,
					pendingTerms,
					bulkId,
					plan.preview.effective_date
				);

				plan.event.metadata = {
					...plan.event.metadata,
					pending_terms: { bulk_id: bulkId, updated: pendingTerms.updated, skipped: pendingTerms.skipped, event_ids: invoiceEventIds },
				};
			}

			if (plan.event.rsm_from_month) {
				await runner.query(`SELECT revenue_schedule_rebuild($1::uuid, $2::date)`, [ctx.contract.id, plan.event.rsm_from_month]);
			}
			const eventId = await this.insertEvent(runner, ctx, plan, created, holdingId, userId, key, key ? requestHash(dto) : null);

			await this.linkEvent(runner, plan, created, eventId, holdingId, dto);
			let quoteStageUpdated: boolean | null = null;

			if (dto.origin?.type === 'quote' && dto.origin.quote_id)
				quoteStageUpdated = await this.markQuoteContractCreated(runner, dto.origin.quote_id, holdingId, {
					contractId: ctx.contract.id,
					contractNumber: ctx.contract.contract_number,
					changeEventId: eventId,
					changeType: dto.change.type,
					userId,
				});
			await runner.commitTransaction();
			active = false;
			if (quoteStageUpdated === false)
				this.logger.warn(`El holding ${holdingId} no tiene la etapa "${QUOTE_CONTRACT_CREATED_STAGE}": la cotización queda en su etapa`);
			// Notificaciones v2: renovar, dar de baja, terminar o aplicar un pacto cierra las alertas del contrato que ya no aplican.
			await this.closeResolvedAlerts(ctx.contract.id, holdingId);

			return {
				...plan.preview,
				applied: true,
				idempotent: false,
				event_id: eventId,
				created,
				detail: await this.contracts.detail(ctx.contract.id, holdingId),
			};
		} catch (error) {
			if (active) await runner.rollbackTransaction();
			if (!(error instanceof HttpException)) {
				this.logger.warn(
					`No se pudo aplicar el cambio al contrato ${resolved.id}: ${error instanceof Error ? error.message : String(error)}`
				);
			}
			throw error;
		} finally {
			await runner.release();
		}
	}

	/** Cierre automático de alertas del contrato (`contract-alerts.ts`); nunca lanza. También lo usa Pactos al omitir o cancelar. */
	async closeResolvedAlerts(contractId: string, holdingId: string): Promise<number> {
		return await reconcileContractAlerts(this.dataSource, this.notifications, holdingId, contractId, (message) => this.logger.warn(message));
	}

	// ---------------------------------------------------------------- job: horizonte de los ítems sin término

	/**
	 * Job `contracts-extend-horizon` para un holding (`planHorizonExtension`): por contrato Activo con ítems recurrentes sin término vivos, una
	 * transacción con la costura y el contrato bloqueado (`FOR UPDATE`, así dos réplicas no duplican: la segunda ve el horizonte cubierto) que
	 * crea las Por Emitir que faltan y un evento `HORIZON_EXTENDED` (actor sistema) solo si creó algo. Un contrato con bloqueos (p. ej. tasa fija
	 * faltante) se omite con un aviso en el log. Devuelve cuántos contratos se extendieron.
	 */
	async extendHorizonForHolding(holdingId: string, actorId: string, today = new Date()): Promise<number> {
		// "Hoy" del holding (ronda 4 de Configuración: `timezone`); el horizonte es fijo (`HORIZON_PERIODS_AHEAD`).
		const day = todayFor(await holdingTimezone(this.dataSource, holdingId), today);
		const contracts = (await this.dataSource.query(
			`SELECT DISTINCT c.id FROM contracts c
			JOIN contract_items ci ON ci.contract_id = c.id AND ci.holding_id = c.holding_id
			WHERE c.holding_id = $1 AND c.deleted_at IS NULL AND c.status = 'Activo'
				AND COALESCE(ci.is_recurring, true) AND ci.end_date IS NULL AND ci.term_months IS NULL AND ci.churn_date IS NULL
			ORDER BY c.id`,
			[holdingId]
		)) as Row[];
		const dto = {
			effective_date: day,
			origin: { type: 'manual' },
			change: { type: 'item_add', items: [] },
		} as unknown as ContractChangeRequestDto;
		let extended = 0;

		for (const row of contracts ?? []) {
			const contractId = String(row.id);
			const runner = this.dataSource.createQueryRunner();

			await runner.connect();
			await runner.startTransaction();
			try {
				await setApiWriter(runner);
				await runner.query(`SELECT id FROM contracts WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL FOR UPDATE`, [
					contractId,
					holdingId,
				]);
				const ctx = await this.loadContext(runner, contractId, holdingId, dto, day);
				const plan = planHorizonExtension(ctx);

				if (!plan || !plan.preview.can_apply) {
					if (plan)
						this.logger.warn(
							`contracts-extend-horizon: contrato ${contractId} omitido: ${plan.preview.blockers.map((blocker) => blocker.message).join('; ')}`
						);
					await runner.rollbackTransaction();
					continue;
				}
				const created = await this.execute(runner, ctx, plan, holdingId, actorId);

				await this.insertEvent(runner, ctx, plan, created, holdingId, actorId, null);
				await runner.commitTransaction();
				extended += 1;
			} catch (error) {
				await runner.rollbackTransaction();
				throw error;
			} finally {
				await runner.release();
			}
		}

		return extended;
	}

	/** Preview "vacío" para la respuesta idempotente: el cambio ya se aplicó, así que solo se informa el contrato actual. */
	private previewWithoutRules(ctx: ChangeContext, dto: ContractChangeRequestDto): ChangePreview {
		const preview = planChange(ctx, dto).preview;

		return {
			...preview,
			items: { ...preview.items, added: [], adjusted: [], ended: [] },
			invoices: { updated: [], created: [], cancelled: [], credit_notes: [] },
			blockers: [],
		};
	}

	// ---------------------------------------------------------------- ejecución de las escrituras (orden: ítems → facturas → contrato)

	private async execute(runner: QueryRunner, ctx: ChangeContext, plan: ChangePlan, holdingId: string, userId: string) {
		const contract = ctx.contract;
		const itemIds = new Map<string, string>();
		const invoices: string[] = [];
		const creditNotes: string[] = [];
		const byInvoice = new Map(ctx.invoices.map((invoice) => [invoice.id, invoice]));
		const issuer: InvoiceIssuer & { client_entity_id: string | null } = {
			contract_id: contract.id,
			holding_id: holdingId,
			company_id: contract.company_id,
			client_id: contract.client_id,
			client_entity_id:
				toText(
					plan.ops.find((op): op is Extract<WriteOp, { kind: 'update_contract' }> => op.kind === 'update_contract')?.set.client_entity_id
				) ?? contract.client_entity_id,
			contract_currency: contract.contract_currency,
			system_currency: contract.system_currency ?? '',
			company_legal_name: contract.company.legal_name,
			company_tax_id: contract.company.tax_id,
			company_address: contract.company.address,
			entity_tax_id: contract.entity.tax_id,
			requires_references_for_billing: contract.requires_references_for_billing,
			auto_invoice: contract.auto_invoice,
		};
		const units: InvoiceLineUnits = new Map();
		// Facturas tocadas: al final se escriben sus montos en moneda del sistema (antes `auto_populate_invoice_fx_to_system`).
		const touched = new Set<string>();
		// Multimoneda (spec §3/§4): con el flag (guardado o encendido por este cambio) el encabezado se recalcula por par y las líneas usan su
		// propia tasa; el monto en moneda de contrato convierte cada línea con la tasa pactada ítem → contrato (las nuevas incluidas).
		const multicurrency =
			contract.requires_multicurrency_billing === true || plan.ops.some((op) => op.kind === 'set_multicurrency' && op.enabled);
		const conversion: ContractConversion | null = multicurrency
			? {
					contract_currency: upperCode(contract.contract_currency),
					item_rates: [
						...(contract.fx_item_rates ?? []),
						...plan.ops.flatMap((op) =>
							op.kind === 'insert_fx_rates'
								? op.rates.filter((rate) => rate.purpose === 'item').map((rate) => ({ ...rate, created_at: '9999' }))
								: []
						),
					],
				}
			: null;
		const lineOf = (invoiceId: string, lineId: string) => byInvoice.get(invoiceId)?.lines.find((line) => line.id === lineId) ?? null;

		for (const item of ctx.items) units.set(item.id, { unit_of_measure: item.unit_of_measure, product_id: item.product_id });
		const order: Array<WriteOp['kind']> = [
			// Multimoneda: el flag va primero (el validador de ítems lo lee al insertar uno en otra moneda).
			'set_multicurrency',
			// §9.3.10: la razón social nueva existe antes de reasignar contrato y facturas.
			'insert_entity',
			'insert_item',
			'update_item',
			// §9.3.3: pausas después de los ítems (el devengo las lee al reconstruirse, después de todo).
			'insert_pause',
			'update_pause',
			// `reactivate`: el espejo se borra después de limpiar el churn del ítem.
			'delete_item',
			'delete_line',
			'update_line',
			// `item_update` (§9.2): la glosa se regenera con los datos ya escritos en el ítem y en la línea (cuenta, glosa, cantidad, precio).
			'regenerate_descriptions',
			// Corrección: motivo del desvío de la Por Emitir que recibe su parte de la diferencia emitida.
			'insert_invoice_adjustment',
			'recompute_header',
			'cancel_invoice',
			'create_invoices',
			'credit_note',
			'update_invoices_fields',
			'update_invoices_document',
			'update_invoices_fx',
			'insert_fx_rates',
			'extend_fx_rates',
			'update_contract',
			// Pactos al final (los ítems nuevos ya tienen id); el enlace al evento va después de insertarlo.
			'insert_scheduled_change',
			'update_scheduled_change',
		];
		const ops = [...plan.ops].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
		const resolveKey = (key: string) => {
			const id = itemIds.get(key);

			if (!id) throw new Error(`ítem nuevo ${key} sin id`);

			return id;
		};
		// Ítem existente o clave `new:N` de un ítem que crea el mismo cambio.
		const resolveRef = (ref: string | null) => (ref && ref.startsWith('new:') ? resolveKey(ref) : ref);
		// §9.3.10: id real de la razón social creada en el acto (reemplaza `NEW_ENTITY_KEY` en contrato, facturas y evento).
		let createdEntityId: string | null = null;
		const resolveEntity = (value: unknown) => (value === NEW_ENTITY_KEY ? createdEntityId : value);
		const pactIds: string[] = [];
		const groupKeys = new Map<string, string>();
		const pauseIds: string[] = [];
		const resumedPauseIds: string[] = [];

		for (const op of ops) {
			switch (op.kind) {
				case 'set_multicurrency':
					await runner.query(`UPDATE contracts SET requires_multicurrency_billing = $3 WHERE id = $1 AND holding_id = $2`, [
						contract.id,
						holdingId,
						op.enabled,
					]);
					break;
				case 'insert_entity': {
					// Mismo camino que el alta desde Cliente 360 (`POST /client-entities`): `insertClientEntity`.
					createdEntityId = await insertClientEntity(runner, holdingId, op.entity);
					issuer.client_entity_id = createdEntityId;
					break;
				}
				case 'delete_item':
					// Espejo de baja sin facturas propias (`reactivate` §9.3.2): primero sus filas de devengo (FK), después el ítem.
					await runner.query(`DELETE FROM revenue_schedule_monthly WHERE contract_item_id = $1 AND holding_id = $2`, [
						op.item_id,
						holdingId,
					]);
					await runner.query(`DELETE FROM contract_items WHERE id = $1 AND holding_id = $2 AND contract_id = $3`, [
						op.item_id,
						holdingId,
						contract.id,
					]);
					break;
				case 'extend_fx_rates':
					for (const rate of op.rates) {
						await runner.query(
							`UPDATE contract_fx_period_rates SET period_end = $3::date,
								notes = COALESCE(notes || E'\n', '') || 'Extendida al nuevo fin por renovación (v2)'
							WHERE id = $1 AND holding_id = $2 AND contract_id = $4`,
							[rate.id, holdingId, rate.period_end, contract.id]
						);
					}
					break;
				case 'insert_scheduled_change': {
					const row = op.row;
					const group = row.group_key ? (groupKeys.get(row.group_key) ?? randomUUID()) : null;

					if (row.group_key && group) groupKeys.set(row.group_key, group);
					const [inserted] = (await runner.query(
						`INSERT INTO contract_scheduled_changes (
							holding_id, contract_id, contract_item_id, group_key, parent_id, trigger, effective_date, kind, value, status,
							status_reason, status_changed_by, applied_value, applied_at, origin, notes, created_by
						) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $10 = 'applied' THEN now() END, $14::jsonb, $15, $12)
						RETURNING id`,
						[
							holdingId,
							contract.id,
							resolveRef(row.contract_item_ref),
							group,
							row.parent_id,
							row.trigger,
							row.effective_date,
							row.kind,
							row.value,
							row.status,
							row.status_reason,
							userId,
							row.applied_value,
							JSON.stringify(row.origin),
							row.notes,
						]
					)) as Row[];

					if (row.status === 'applied') pactIds.push(String(inserted.id));
					break;
				}
				case 'update_scheduled_change': {
					const sets: string[] = [];
					const params: unknown[] = [op.id, holdingId, contract.id];
					const add = (column: string, value: unknown) => {
						params.push(value);
						sets.push(`${column} = $${params.length}`);
					};

					if (op.set.status !== undefined) {
						add('status', op.set.status);
						add('status_changed_by', userId);
						if (op.set.status === 'applied') {
							sets.push('applied_at = now()');
							pactIds.push(op.id);
						}
					}
					if (op.set.status_reason !== undefined) add('status_reason', op.set.status_reason);
					if (op.set.applied_value !== undefined) add('applied_value', op.set.applied_value);
					if (op.set.next_effective_date !== undefined) add('next_effective_date', op.set.next_effective_date);
					if (sets.length)
						await runner.query(
							`UPDATE contract_scheduled_changes SET ${sets.join(', ')} WHERE id = $1 AND holding_id = $2 AND contract_id = $3`,
							params
						);
					break;
				}
				case 'mark_events_reversed':
					// Se escribe después del evento nuevo (`linkEvent`).
					break;
				case 'insert_pause': {
					const pause = op.pause;
					const [row] = (await runner.query(
						`INSERT INTO contract_item_pauses (holding_id, contract_id, contract_item_id, pause_start, pause_end, extend_term, status, reason, created_by)
						VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9) RETURNING id`,
						[
							holdingId,
							contract.id,
							resolveRef(pause.contract_item_id),
							pause.pause_start,
							pause.pause_end,
							pause.extend_term,
							pause.status,
							pause.reason,
							userId,
						]
					)) as Row[];

					pauseIds.push(String(row.id));
					break;
				}
				case 'update_pause':
					await runner.query(
						`UPDATE contract_item_pauses SET pause_end = $4::date, status = $5
						WHERE id = $1 AND holding_id = $2 AND contract_id = $3 AND status <> 'cancelled'`,
						[op.id, holdingId, contract.id, op.set.pause_end, op.set.status]
					);
					resumedPauseIds.push(op.id);
					break;
				case 'insert_item': {
					const item = op.item;
					// Precios derivados (antes `auto_calculate_pricing_fields`, con su rama CHURN/DOWNSELL): los escribe la API.
					const prices = pricingFields(
						{
							unit_price: item.unit_price,
							annual_unit_price: item.annual_unit_price,
							price_entry_mode: item.price_entry_mode,
							quantity: item.quantity,
							billing_frequency: item.billing_frequency,
							is_recurring: item.is_recurring,
							final_price: item.final_price,
							term_months: item.term_months,
							discount_type: item.discount_type,
							discount_value: item.discount_value,
							categoria: item.categoria,
						},
						'contract_items'
					);
					const [row] = (await runner.query(
						`INSERT INTO contract_items (
							contract_id, holding_id, product_id, product_name, account, item_type, unit_of_measure, categoria,
							quantity, unit_price, annual_unit_price, price_entry_mode, discount_type, discount_value,
							price, final_price, currency, billing_frequency, billing_method, start_date, end_date, term_months,
							is_recurring, related_item_id, renews_item_id, booking_date, auto_renew, price_id, quote_item_id,
							annual_price, monthly_price, billing_period_price, billing_anchor_day
						) VALUES (
							$1, $2, $3, $4, $5, $6, $7, $8,
							$9, $10, $11, $12, $13, $14,
							$15, $16, $17, $18, $19, $20, $21, $22,
							$23, $24, $25, $26, $27, $28, $29,
							$30, $31, $32, $33
						) RETURNING id`,
						[
							contract.id,
							holdingId,
							item.product_id,
							item.product_name,
							item.account,
							item.item_type,
							item.unit_of_measure,
							item.categoria,
							item.quantity,
							prices.unit_price,
							prices.annual_unit_price,
							prices.price_entry_mode,
							item.discount_type,
							item.discount_value,
							item.price,
							item.final_price,
							item.currency,
							item.billing_frequency,
							item.billing_method,
							item.start_date,
							item.end_date,
							item.term_months,
							item.is_recurring,
							// El ajuste de una renovación apunta a su RENEWAL, que nace en el mismo cambio (`new:N`).
							resolveRef(item.related_item_id),
							item.renews_item_id,
							item.booking_date,
							item.auto_renew,
							item.price_id,
							item.quote_item_id,
							prices.annual_price,
							prices.monthly_price,
							prices.billing_period_price,
							// §9.3.9: ciclo propio del ítem (NULL = el del contrato).
							item.billing_anchor_day ?? null,
						]
					)) as Row[];
					const id = String(row.id);

					itemIds.set(item.key, id);
					units.set(item.key, { unit_of_measure: item.unit_of_measure, product_id: item.product_id });
					units.set(id, { unit_of_measure: item.unit_of_measure, product_id: item.product_id });
					// El fin explícito (co-terminación, S4-16) va en el INSERT: `set_contract_item_end_date` ya no lo recalcula.
					// Pricing v2: el precio inline (o la copia del catálogo, etapa 3: `list_price_id`) nace como fila de `prices`
					// (owner = contract, v1 activa) y el ítem la apunta (spec §2.2).
					if (item.price_spec) {
						const spec = item.price_spec;
						const [price] = (await runner.query(
							`INSERT INTO prices (
								holding_id, owner, product_id, contract_id, name, currency, model, quantity_type, billable_metric_id,
								unit_amount, tiers, package_size, package_amount, seat_minimum_quantity, free_units, minimum_amount, cap_amount,
								status, version, supersedes_price_id, created_by, updated_by, published_at, invoice_line_mode, charge_flat_when_free, list_price_id
							) VALUES (
								$1, 'contract', $2, $3, $4, $5, $6, $7, $8,
								$9, $10::jsonb, $11, $12, $13, $14, $15, $16,
								'active', 1, NULL, $17, $17, now(), $18, $19, $20
							) RETURNING id`,
							[
								holdingId,
								item.product_id,
								contract.id,
								item.price_name ?? item.product_name,
								item.currency,
								spec.model,
								spec.quantity_type,
								spec.billable_metric_id ?? null,
								spec.unit_amount ?? null,
								spec.tiers ? JSON.stringify(spec.tiers) : null,
								spec.package_size ?? null,
								spec.package_amount ?? null,
								spec.seat_minimum_quantity ?? 0,
								spec.free_units ?? 0,
								spec.minimum_amount ?? null,
								spec.cap_amount ?? null,
								userId,
								spec.invoice_line_mode ?? DEFAULT_INVOICE_LINE_MODE,
								spec.charge_flat_when_free === true,
								item.list_price_id ?? null,
							]
						)) as Row[];

						await runner.query(`UPDATE contract_items SET price_id = $3 WHERE id = $1 AND holding_id = $2`, [
							id,
							holdingId,
							String(price.id),
						]);
					}
					break;
				}
				case 'update_item': {
					const sets: string[] = [];
					const params: unknown[] = [op.item_id, holdingId];
					const add = (column: string, value: unknown) => {
						params.push(value);
						sets.push(`${column} = $${params.length}`);
					};

					if (op.set.churn_date !== undefined) add('churn_date', op.set.churn_date);
					if (op.set.churn_monthly_amount !== undefined) add('churn_monthly_amount', op.set.churn_monthly_amount);
					if (op.set.renewed_by_key !== undefined) add('renewed_by_item_id', resolveKey(op.set.renewed_by_key));
					// §9.3.7: el ítem cortado termina el día antes del corte con su valor por los meses que quedan (mismo mensual).
					if (op.set.end_date !== undefined) add('end_date', op.set.end_date);
					if (op.set.term_months !== undefined) add('term_months', op.set.term_months);
					if (op.set.price !== undefined) add('price', op.set.price);
					if (op.set.final_price !== undefined) add('final_price', op.set.final_price);
					// §9.3.5: `billing_conditions.auto_renew` sobre los ítems recurrentes vivos.
					if (op.set.auto_renew !== undefined) add('auto_renew', op.set.auto_renew);
					// §9.2 `item_update`: la cuenta y, al corregir un dato, glosa, tipo y valores (precios derivados calculados en el plan con `pricingFields`).
					if (op.set.account !== undefined) add('account', op.set.account);
					for (const column of [
						'product_name',
						'item_type',
						'quantity',
						'unit_price',
						'annual_unit_price',
						'annual_price',
						'price_entry_mode',
						'discount_type',
						'discount_value',
						'monthly_price',
						'billing_period_price',
					] as const)
						if (op.set[column] !== undefined) add(column, op.set[column]);
					if (sets.length) await runner.query(`UPDATE contract_items SET ${sets.join(', ')} WHERE id = $1 AND holding_id = $2`, params);
					break;
				}
				case 'regenerate_descriptions': {
					// Mismo constructor que el 360 (plantilla del contrato, ajuste al límite); salta protegidas, editadas a mano y bloqueadas.
					const regenerated = await this.descriptions.regenerateLines(runner, contract.id, holdingId, op.line_ids);

					plan.event.metadata = {
						...plan.event.metadata,
						descriptions_regenerated: regenerated.map((line) => ({
							line_id: line.line_id,
							invoice_id: line.invoice_id,
							before: line.before,
							after: line.after,
						})),
					};
					break;
				}
				case 'insert_invoice_adjustment':
					await runner.query(
						`INSERT INTO invoice_adjustments (invoice_id, holding_id, type, amount_diff, notes, adjusted_by) VALUES ($1, $2, $3, $4, $5, $6)`,
						[op.invoice_id, holdingId, op.type, op.amount_diff, op.notes, userId]
					);
					break;
				case 'delete_line':
					touched.add(op.invoice_id);
					await runner.query(`DELETE FROM invoice_items WHERE id = $1 AND invoice_id = $2 AND holding_id = $3`, [
						op.line_id,
						op.invoice_id,
						holdingId,
					]);
					break;
				case 'update_line': {
					touched.add(op.invoice_id);
					// Multimoneda: la línea se valoriza con la tasa de su par (la suya), no con la del encabezado.
					const fx = multicurrency ? (lineOf(op.invoice_id, op.line_id)?.fx ?? null) : (byInvoice.get(op.invoice_id)?.fx ?? null);
					const values = op.values;
					const inInvoice = (value: number) => (fx === null ? null : round2(value * fx));

					await runner.query(
						`UPDATE invoice_items SET quantity = $3, unit_price_contract_currency = $4, unit_price_invoice_currency = $5, discount_pct = $6,
							subtotal_contract_currency = $7, subtotal_invoice_currency = $8, tax_amount_contract_currency = $9, tax_amount_invoice_currency = $10,
							total_contract_currency = $11, total_invoice_currency = $12,
							billing_period_end = COALESCE($13::date, billing_period_end),
							-- Pausa (§9.3.3): la línea cuyo período empieza en la pausa queda desde el día siguiente a su fin.
							billing_period_start = COALESCE($18::date, billing_period_start),
							-- Una glosa escrita a mano (description_locked, spec facturas §3.6) no se toca.
							description = CASE WHEN description_locked THEN description ELSE description || $14 END,
							-- Línea con consumo registrado: el desglose del motor se reescribe con la cantidad registrada (las demás lo conservan).
							pricing_breakdown = COALESCE($16::jsonb, pricing_breakdown), quantity_source = COALESCE($17, quantity_source), updated_at = now()
						WHERE id = $1 AND invoice_id = $2 AND holding_id = $15`,
						[
							op.line_id,
							op.invoice_id,
							values.quantity,
							values.unit_price,
							fx === null ? null : round6(values.unit_price * fx),
							values.discount_pct,
							values.subtotal,
							inInvoice(values.subtotal),
							values.tax_amount,
							inInvoice(values.tax_amount),
							values.total,
							inInvoice(values.total),
							values.billing_period_end ?? null,
							values.description_suffix ?? '',
							holdingId,
							values.pricing_breakdown ? JSON.stringify(values.pricing_breakdown) : null,
							values.quantity_source ?? null,
							values.billing_period_start ?? null,
						]
					);
					break;
				}
				case 'recompute_header':
					touched.add(op.invoice_id);
					await this.recomputeHeader(runner, op.invoice_id, holdingId, byInvoice.get(op.invoice_id) ?? null, op.note, conversion);
					break;
				case 'cancel_invoice':
					touched.add(op.invoice_id);
					await runner.query(
						`UPDATE invoices SET status = 'Cancelada', notes = COALESCE(notes || E'\\n', '') || $3
						WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
						[op.invoice_id, holdingId, op.note]
					);
					break;
				case 'create_invoices': {
					for (const [index, engineInvoice] of op.invoices.entries()) {
						const target = op.merge_into[index];
						// Las líneas del generador apuntan a la clave temporal del ítem nuevo (`new:N`): se traduce al id real ya insertado.
						const invoice = {
							...engineInvoice,
							lines: engineInvoice.lines.map((line) => ({ ...line, item_key: itemIds.get(line.item_key) ?? line.item_key })),
						};

						if (target) {
							// F3: la línea que se suma hereda política y tasa FX de esa Por Emitir (S6-2).
							const existing = byInvoice.get(target);
							const fx = existing?.fx ?? null;

							touched.add(target);
							await insertEngineLines(runner, issuer, target, invoice, fx, null, units);
							await this.recomputeHeader(
								runner,
								target,
								holdingId,
								existing ?? null,
								`Línea agregada por modificación del contrato (${plan.preview.type})`,
								conversion
							);
						} else {
							const [id] = await insertEngineInvoices(runner, issuer, [invoice], [op.fixed_rates[index] ?? null], units);

							invoices.push(id);
						}
					}
					break;
				}
				case 'credit_note':
					creditNotes.push(
						await this.insertCreditNote(runner, op.mirrors, op.lines, op.note, holdingId, plan.preview.effective_date, userId)
					);
					break;
				case 'update_invoices_fields': {
					op.invoice_ids.forEach((id) => touched.add(id));
					const columns = Object.keys(op.set);
					const params: unknown[] = [op.invoice_ids, holdingId, ...columns.map((column) => resolveEntity(op.set[column]))];

					await runner.query(
						`UPDATE invoices SET ${columns.map((column, index) => `${column} = $${index + 3}`).join(', ')}
						WHERE id = ANY($1::uuid[]) AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
						params
					);
					break;
				}
				case 'update_invoices_document': {
					op.invoice_ids.forEach((id) => touched.add(id));
					await runner.query(
						`UPDATE invoices SET document_type = $3, export_type = $4, tax_rate = $5
						WHERE id = ANY($1::uuid[]) AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
						[op.invoice_ids, holdingId, op.document_type, op.export_type, op.tax_rate]
					);
					// IVA de cada línea = neto × tasa; en moneda de factura solo si la línea ya está valorizada.
					await runner.query(
						`UPDATE invoice_items SET
							tax_amount_contract_currency = ROUND(subtotal_contract_currency * $3 / 100, 2),
							total_contract_currency = subtotal_contract_currency + ROUND(subtotal_contract_currency * $3 / 100, 2),
							tax_amount_invoice_currency = CASE WHEN subtotal_invoice_currency IS NULL THEN NULL ELSE ROUND(subtotal_invoice_currency * $3 / 100, 2) END,
							total_invoice_currency = CASE WHEN subtotal_invoice_currency IS NULL THEN NULL ELSE subtotal_invoice_currency + ROUND(subtotal_invoice_currency * $3 / 100, 2) END,
							updated_at = now()
						WHERE invoice_id = ANY($1::uuid[]) AND holding_id = $2`,
						[op.invoice_ids, holdingId, op.tax_rate]
					);
					for (const invoiceId of op.invoice_ids) {
						const existing = byInvoice.get(invoiceId);

						await this.recomputeHeader(
							runner,
							invoiceId,
							holdingId,
							existing ? { ...existing, tax_rate: op.tax_rate } : null,
							`Documento ${op.document_type}`,
							conversion
						);
					}
					break;
				}
				case 'update_invoices_fx': {
					for (const target of op.targets) {
						const existing = byInvoice.get(target.invoice_id);

						touched.add(target.invoice_id);
						if (target.lines) {
							// Multimoneda: cada línea con la tasa de su par y sus montos ya valorizados (residuo por par en la línea mayor).
							for (const line of target.lines) {
								await runner.query(
									`UPDATE invoice_items SET invoice_currency = $3, fx_contract_to_invoice = $4,
										fx_rate_source = CASE WHEN $4::numeric IS NULL THEN NULL ELSE $5 END,
										fx_rate_date = CASE WHEN $4::numeric IS NULL THEN NULL ELSE CURRENT_DATE END,
										unit_price_invoice_currency = $6, subtotal_invoice_currency = $7, tax_amount_invoice_currency = $8,
										total_invoice_currency = $9, updated_at = now()
									WHERE id = $1 AND holding_id = $2`,
									[
										line.line_id,
										holdingId,
										op.invoice_currency,
										line.fx,
										CHANGES_FX_RATE_SOURCE,
										line.amounts?.unit_price ?? null,
										line.amounts?.subtotal ?? null,
										line.amounts?.tax ?? null,
										line.amounts?.total ?? null,
									]
								);
							}
							await runner.query(
								`UPDATE invoices SET invoice_currency = $3, fx_contract_to_invoice = $4 WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
								[target.invoice_id, holdingId, op.invoice_currency, target.fx]
							);
							await this.recomputeHeader(
								runner,
								target.invoice_id,
								holdingId,
								existing ? { ...existing, fx: target.fx } : null,
								`Moneda de facturación ${op.invoice_currency}`,
								conversion
							);
							continue;
						}
						await runner.query(
							// Sin tasa (spot que se valoriza al emitir): origen y fecha de la tasa en NULL, como el resto de la línea en moneda de factura.
							`UPDATE invoice_items SET invoice_currency = $3, fx_contract_to_invoice = $4,
								fx_rate_source = CASE WHEN $4::numeric IS NULL THEN NULL ELSE $5 END,
								fx_rate_date = CASE WHEN $4::numeric IS NULL THEN NULL ELSE CURRENT_DATE END,
								unit_price_invoice_currency = CASE WHEN $4::numeric IS NULL THEN NULL ELSE ROUND(unit_price_contract_currency * $4, 6) END,
								subtotal_invoice_currency = CASE WHEN $4::numeric IS NULL THEN NULL ELSE ROUND(subtotal_contract_currency * $4, 2) END,
								tax_amount_invoice_currency = CASE WHEN $4::numeric IS NULL THEN NULL ELSE ROUND(tax_amount_contract_currency * $4, 2) END,
								total_invoice_currency = CASE WHEN $4::numeric IS NULL THEN NULL ELSE ROUND(total_contract_currency * $4, 2) END,
								updated_at = now()
							WHERE invoice_id = $1 AND holding_id = $2`,
							[target.invoice_id, holdingId, op.invoice_currency, target.fx, CHANGES_FX_RATE_SOURCE]
						);
						await runner.query(
							`UPDATE invoices SET invoice_currency = $3, fx_contract_to_invoice = $4 WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
							[target.invoice_id, holdingId, op.invoice_currency, target.fx]
						);
						await this.recomputeHeader(
							runner,
							target.invoice_id,
							holdingId,
							existing ? { ...existing, fx: target.fx } : null,
							`Moneda de facturación ${op.invoice_currency}`
						);
					}
					break;
				}
				case 'insert_fx_rates':
					for (const rate of op.rates) {
						await runner.query(
							`INSERT INTO contract_fx_period_rates (contract_id, holding_id, purpose, from_currency, to_currency, rate, period_start, period_end, notes)
							VALUES ($1, $2, $9, $3, $4, $5, $6, $7, $8)`,
							[
								contract.id,
								holdingId,
								rate.from_currency,
								rate.to_currency,
								rate.rate,
								rate.period_start,
								rate.period_end,
								rate.purpose === 'item'
									? 'Tasa pactada ítem → contrato (modificación v2)'
									: 'Condiciones de facturación (modificación v2)',
								rate.purpose ?? 'invoice',
							]
						);
					}
					break;
				case 'update_contract': {
					const columns = Object.keys(op.set);

					if (!columns.length) break;
					// Mover el fin del contrato Activo exige el bypass explícito del guard, siempre con evento (mapa §4).
					if (op.bypass_end_date_guard) await runner.query(`SELECT set_config('sapira.bypass_end_date_guard', 'on', true)`);
					const fxColumns = `status, total_value, contract_currency, booking_date::text AS booking_date`;
					const [before] = (await runner.query(`SELECT ${fxColumns} FROM contracts WHERE id = $1 AND holding_id = $2`, [
						contract.id,
						holdingId,
					])) as Row[];
					const [after] = (await runner.query(
						`UPDATE contracts SET ${columns.map((column, index) => `${column} = $${index + 3}`).join(', ')} WHERE id = $1 AND holding_id = $2
						RETURNING ${fxColumns}`,
						[contract.id, holdingId, ...columns.map((column) => resolveEntity(op.set[column]))]
					)) as Row[];

					// FX a la moneda del sistema del contrato (antes `auto_calculate_contract_fx`), con su misma condición; además, si cambió el
					// valor total se refresca en cualquier estado (la cancelación pasa a Cancelado y el total en moneda del sistema debe seguirlo).
					if (contractFxNeedsRefresh(before, after) || totalValueChanged(before, after))
						await refreshContractSystemFx(runner, contract.id, holdingId);
					break;
				}
			}
		}
		// `contracts.term` = mayor plazo de los ítems (antes `update_contract_term`) y montos en moneda del sistema.
		if (itemIds.size) await syncContractTerm(runner, contract.id, holdingId);
		await refreshInvoiceSystemAmounts(runner, holdingId, [...touched]);

		return {
			items: Object.fromEntries(itemIds),
			invoices,
			credit_notes: creditNotes,
			entity_id: createdEntityId,
			scheduled_changes: pactIds,
			pauses: pauseIds,
			resumed_pauses: resumedPauseIds,
		};
	}

	/**
	 * Después del evento: los pactos aplicados por el cambio quedan ligados a él (`applied_event_id`, §9.4 #1), los eventos de baja que
	 * revierte `reactivate` reciben `metadata.reversed_by` (§9.3.2), las pausas su `pause_event_id` / `resume_event_id` (§9.3.3) y la
	 * propuesta de renovación confirmada queda `confirmed` con `metadata.confirmed_by_event_id` (§9.3.5).
	 */
	private async linkEvent(
		runner: QueryRunner,
		plan: ChangePlan,
		created: ChangeCreated,
		eventId: string,
		holdingId: string,
		dto?: ContractChangeRequestDto
	) {
		if (created.pauses?.length)
			await runner.query(`UPDATE contract_item_pauses SET pause_event_id = $3 WHERE id = ANY($1::uuid[]) AND holding_id = $2`, [
				created.pauses,
				holdingId,
				eventId,
			]);
		if (created.resumed_pauses?.length)
			await runner.query(`UPDATE contract_item_pauses SET resume_event_id = $3 WHERE id = ANY($1::uuid[]) AND holding_id = $2`, [
				created.resumed_pauses,
				holdingId,
				eventId,
			]);
		if (dto?.origin?.type === 'renewal_proposal' && dto.origin.event_id)
			await runner.query(
				`UPDATE contract_lifecycle_events SET event_status = 'Completed', completed_at = now(),
					metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('status', 'confirmed', 'confirmed_by_event_id', $3::text, 'confirmed_at', now())
				WHERE id = $1 AND holding_id = $2 AND event_type = 'RENEWAL_PROPOSED'`,
				[dto.origin.event_id, holdingId, eventId]
			);
		if (created.scheduled_changes?.length)
			await runner.query(
				`UPDATE contract_scheduled_changes SET applied_event_id = $3, applied_at = COALESCE(applied_at, now())
				WHERE id = ANY($1::uuid[]) AND holding_id = $2`,
				[created.scheduled_changes, holdingId, eventId]
			);
		for (const op of plan.ops) {
			if (op.kind !== 'mark_events_reversed' || !op.event_ids.length) continue;
			await runner.query(
				`UPDATE contract_lifecycle_events SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('reversed_by', $3::text)
				WHERE id = ANY($1::uuid[]) AND holding_id = $2`,
				[op.event_ids, holdingId, eventId]
			);
		}
	}

	/** Encabezado = Σ líneas (las no tocadas no se reescriben); sin líneas → Cancelada. */
	private async recomputeHeader(
		runner: QueryRunner,
		invoiceId: string,
		holdingId: string,
		invoice: Pick<ChangeInvoiceRow, 'tax_rate' | 'fx'> | null,
		note: string,
		conversion: ContractConversion | null = null
	) {
		if (conversion) {
			await this.recomputeMulticurrencyHeader(runner, invoiceId, holdingId, invoice, note, conversion);

			return;
		}
		const [sums] = (await runner.query(
			`SELECT COUNT(*) AS lines, COALESCE(SUM(subtotal_contract_currency), 0) AS subtotal, COALESCE(SUM(tax_amount_contract_currency), 0) AS tax
			FROM invoice_items WHERE invoice_id = $1 AND holding_id = $2`,
			[invoiceId, holdingId]
		)) as Row[];

		if (toNumber(sums?.lines) === 0) {
			await runner.query(
				`UPDATE invoices SET status = 'Cancelada', notes = COALESCE(notes || E'\\n', '') || $3 WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
				[invoiceId, holdingId, note]
			);

			return;
		}
		const header = headerAmounts(toNumber(sums?.subtotal), toNumber(sums?.tax), invoice?.tax_rate ?? 0, invoice?.fx ?? null);

		// `tax_rate` se reescribe normalizado (0,19 → 19) para que el encabezado quede coherente con el IVA recalculado.
		await runner.query(
			`UPDATE invoices SET amount_contract_currency = $3, vat = $4, amount_invoice_currency = $5, total_invoice_currency = $6,
				tax_rate = COALESCE($7::numeric, tax_rate)
			WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
			[
				invoiceId,
				holdingId,
				header.amount_contract_currency,
				header.vat,
				header.amount_invoice_currency,
				header.total_invoice_currency,
				invoice?.tax_rate ?? null,
			]
		);
	}

	/**
	 * Multimoneda: encabezado = Σ líneas por par (`multicurrencyHeader`): moneda de contrato con la tasa pactada ítem → contrato de cada línea;
	 * moneda de factura = Σ líneas si todas están valorizadas (si no NULL); FX del encabezado = el del único par convertidor o NULL.
	 */
	private async recomputeMulticurrencyHeader(
		runner: QueryRunner,
		invoiceId: string,
		holdingId: string,
		invoice: Pick<ChangeInvoiceRow, 'tax_rate'> | null,
		note: string,
		conversion: ContractConversion
	) {
		const rows = ((await runner.query(
			`SELECT ii.contract_currency, ii.subtotal_contract_currency, ii.tax_amount_contract_currency, ii.subtotal_invoice_currency,
				ii.tax_amount_invoice_currency, ii.fx_contract_to_invoice, ii.billing_period_start::text AS billing_period_start,
				i.invoice_currency, i.issue_date::text AS issue_date
			FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
			WHERE ii.invoice_id = $1 AND ii.holding_id = $2`,
			[invoiceId, holdingId]
		)) ?? []) as Row[];

		if (!rows.length) {
			await runner.query(
				`UPDATE invoices SET status = 'Cancelada', notes = COALESCE(notes || E'\\n', '') || $3 WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
				[invoiceId, holdingId, note]
			);

			return;
		}
		const header = multicurrencyHeader(
			rows.map((row) => ({
				currency: toText(row.contract_currency),
				subtotal: toNumber(row.subtotal_contract_currency),
				tax: toNumber(row.tax_amount_contract_currency),
				subtotal_invoice: toNullableNumber(row.subtotal_invoice_currency),
				tax_invoice: toNullableNumber(row.tax_amount_invoice_currency),
				fx: toNullableNumber(row.fx_contract_to_invoice),
				period_start: toText(row.billing_period_start),
			})),
			{
				contract_currency: conversion.contract_currency,
				invoice_currency: toText(rows[0].invoice_currency) ?? conversion.contract_currency,
				item_rates: conversion.item_rates,
				fallback_date: toText(rows[0].issue_date) ?? '',
			}
		);

		await runner.query(
			`UPDATE invoices SET amount_contract_currency = $3, vat = $4, amount_invoice_currency = $5, total_invoice_currency = $6,
				fx_contract_to_invoice = $7, tax_rate = COALESCE($8::numeric, tax_rate)
			WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
			[
				invoiceId,
				holdingId,
				header.amount_contract_currency,
				header.vat,
				header.amount_invoice_currency,
				header.total_invoice_currency,
				header.fx,
				invoice?.tax_rate ?? null,
			]
		);
	}

	/** NC espejo de una emitida: delega en `insertMirrorCreditNote` (la reutiliza el consumo para reemitir, spec pricing §4.4). */
	private async insertCreditNote(
		runner: QueryRunner,
		mirrors: ChangeInvoiceRow,
		lines: Array<{ line: ChangeInvoiceLineRow; ratio: number; period_start: string }>,
		note: string,
		holdingId: string,
		effectiveDate: string,
		userId: string | null = null
	): Promise<string> {
		const creditReason = note.includes('cancelación') ? 'churn' : 'downsell';

		return await insertMirrorCreditNote(runner, mirrors, lines, note, holdingId, effectiveDate, {
			credit_reason: creditReason,
			line_suffix: (periodStart) => ` (NC espejo por baja desde el ${periodStart})`,
			reference: { kind: 'discount', reason: note, user_id: userId },
		});
	}

	private async insertEvent(
		runner: QueryRunner,
		ctx: ChangeContext,
		plan: ChangePlan,
		created: ChangeCreated,
		holdingId: string,
		userId: string,
		idempotencyKey: string | null,
		bodyHash: string | null = null
	): Promise<string> {
		const event = plan.event;
		const itemsAffected = [...event.items_affected, ...event.new_item_keys.map((key) => created.items[key]).filter(Boolean)];
		const [row] = (await runner.query(
			`INSERT INTO contract_lifecycle_events (
				contract_id, holding_id, event_type, event_subtype, event_status, title, description, summary, created_by, completed_at,
				effective_date, amount_delta, items_affected, metadata
			) VALUES ($1, $2, $3, $4, 'Completed', $5, $6, $6, $7, now(), $8::date, $9, $10::jsonb, $11::jsonb) RETURNING id`,
			[
				ctx.contract.id,
				holdingId,
				event.type,
				event.subtype,
				event.title,
				event.description,
				userId,
				plan.preview.effective_date,
				event.amount_delta,
				JSON.stringify(itemsAffected),
				// §9.3.10: la razón social creada en el acto reemplaza su clave temporal.
				JSON.stringify({
					...event.metadata,
					contract_number: ctx.contract.contract_number,
					idempotency_key: idempotencyKey,
					// Reintento con la misma clave: se compara el cuerpo y se devuelve este mismo preview (`idempotent: true`).
					request_hash: bodyHash,
					preview: plan.preview,
					created_items: created.items,
					created_invoices: created.invoices,
					created_credit_notes: created.credit_notes,
					created_entity_id: created.entity_id ?? null,
					scheduled_changes_applied: created.scheduled_changes ?? [],
					created_pauses: created.pauses ?? [],
					resumed_pauses: created.resumed_pauses ?? [],
					invoices_updated: plan.preview.invoices.updated.map((invoice) => invoice.id),
					invoices_cancelled: plan.preview.invoices.cancelled.map((invoice) => invoice.id),
					rsm_from_month: event.rsm_from_month,
				})
					.split(JSON.stringify(NEW_ENTITY_KEY))
					.join(JSON.stringify(created.entity_id ?? null)),
			]
		)) as Row[];

		return String(row.id);
	}

	/**
	 * Cotización de origen → etapa "Contrato creado" (mapa M1: solo al final) y evento `APPLIED_TO_CONTRACT` en su historial
	 * (`quote_events`), en la misma transacción del cambio. La etapa se busca por `kind = contract_created` y, si el holding
	 * no la tiene con kind, por nombre (igual que el alta desde cotización). Sin etapa, la cotización queda donde está, pero
	 * el evento se registra igual (`metadata.stage_updated = false`).
	 */
	private async markQuoteContractCreated(
		runner: QueryRunner,
		quoteId: string,
		holdingId: string,
		link: { contractId: string; contractNumber: string | null; changeEventId: string; changeType: string; userId: string }
	): Promise<boolean> {
		const [from] = (await runner.query(
			`SELECT q.quote_stage_id, qs.kind FROM quotes q LEFT JOIN quote_stages qs ON qs.id = q.quote_stage_id WHERE q.id = $1 AND q.holding_id = $2`,
			[quoteId, holdingId]
		)) as Row[];
		const [stage] = (await runner.query(
			`SELECT id, kind FROM quote_stages WHERE holding_id = $1 AND (kind = 'contract_created' OR lower(name) = lower($2))
			ORDER BY (kind = 'contract_created') DESC NULLS LAST, position LIMIT 1`,
			[holdingId, QUOTE_CONTRACT_CREATED_STAGE]
		)) as Row[];
		const toStageId = stage ? String(stage.id) : null;

		if (toStageId) await runner.query(`UPDATE quotes SET quote_stage_id = $3 WHERE id = $1 AND holding_id = $2`, [quoteId, holdingId, toStageId]);
		await runner.query(
			`INSERT INTO quote_events (holding_id, quote_id, type, from_stage_id, to_stage_id, from_kind, to_kind, actor_id, metadata)
			VALUES ($1, $2, 'APPLIED_TO_CONTRACT', $3, $4, $5, $6, $7, $8::jsonb)`,
			[
				holdingId,
				quoteId,
				toText(from?.quote_stage_id),
				toStageId ?? toText(from?.quote_stage_id),
				toText(from?.kind),
				toStageId ? 'contract_created' : toText(from?.kind),
				link.userId,
				JSON.stringify({
					source: 'api_v2',
					contract_id: link.contractId,
					contract_number: link.contractNumber,
					change_event_id: link.changeEventId,
					change_type: link.changeType,
					stage_updated: Boolean(toStageId),
				}),
			]
		);

		return Boolean(toStageId);
	}

	// ---------------------------------------------------------------- lectura del contexto

	/** Todo lo que el plan necesita, en una sola pasada (dentro de la transacción al aplicar; sin ella en el preview). */
	async loadContext(db: Queryable, contractId: string, holdingId: string, dto: ContractChangeRequestDto, today: string): Promise<ChangeContext> {
		const change = dto.change;
		const productIds =
			change.type === 'item_add' ? [...new Set((change.items ?? []).map((item) => String(item.product_id ?? '')).filter(Boolean))] : [];
		const metricIds =
			change.type === 'item_add'
				? [
						...new Set(
							(change.items ?? [])
								.map((item) => (item.price as { billable_metric_id?: string | null } | null | undefined)?.billable_metric_id)
								.filter((id): id is string => typeof id === 'string' && id.length > 0)
						),
					]
				: [];
		const catalogIds = change.type === 'item_add' ? catalogPriceIds(change.items ?? []) : [];
		const [
			[contractRow],
			itemRows,
			invoiceRows,
			lineRows,
			overrideRows,
			reasonRows,
			entityRows,
			productRows,
			taxDocRows,
			quoteRows,
			metricRows,
			catalogPrices,
			creditedRows,
			consumptionRows,
			extra,
		] = await Promise.all([
			db.query(
				`SELECT c.id, c.contract_number, c.status, c.client_id, c.client_entity_id, c.company_id, c.quote_id,
					c.contract_currency, c.invoice_currency, c.system_currency, c.company_currency AS contract_company_currency,
					c.fx_invoice_policy, c.fx_company_policy, c.group_invoices_by_period, c.auto_invoice, c.auto_send_to_odoo, c.requires_references_for_billing,
					c.billing_anchor_day, c.payment_terms, c.document_type, c.tax_document_type_id, tdt.kind AS tax_document_type_kind, tdt.tax_rate AS tax_document_tax_rate,
					tdt.description_max_chars AS own_description_max_chars, ${DESCRIPTION_LIMITS_SQL} AS description_limits,
					c.invoice_terms_and_conditions, c.total_value, c.contract_end_date::text AS contract_end_date, c.invoice_description_template,
					co.legal_name AS company_legal_name, co.tax_id AS company_tax_id, co.legal_address AS company_address, co.country AS company_country,
					co.tax_rate AS company_tax_rate, co.currency AS company_currency,
					ce.id AS entity_id, ce.legal_name AS entity_legal_name, ce.tax_id AS entity_tax_id, ce.country AS entity_country, ce.payment_terms AS entity_payment_terms,
					(SELECT COALESCE(jsonb_agg(jsonb_build_object(
							'from_currency', r.from_currency, 'to_currency', r.to_currency, 'rate', r.rate,
							'period_start', r.period_start, 'period_end', r.period_end, 'created_at', r.created_at)), '[]'::jsonb)
						FROM contract_fx_period_rates r WHERE r.contract_id = c.id AND r.holding_id = c.holding_id AND r.purpose = 'invoice') AS fx_invoice_rates,
					(SELECT COALESCE(jsonb_agg(jsonb_build_object(
							'from_currency', r.from_currency, 'to_currency', r.to_currency, 'rate', r.rate,
							'period_start', r.period_start, 'period_end', r.period_end, 'created_at', r.created_at)), '[]'::jsonb)
						FROM contract_fx_period_rates r WHERE r.contract_id = c.id AND r.holding_id = c.holding_id AND r.purpose = 'item') AS fx_item_rates,
					COALESCE(c.requires_multicurrency_billing, false) AS requires_multicurrency_billing,
					(SELECT COALESCE(jsonb_agg(jsonb_build_object(
							'id', r.id, 'purpose', r.purpose, 'from_currency', r.from_currency, 'to_currency', r.to_currency, 'rate', r.rate,
							'period_start', r.period_start, 'period_end', r.period_end, 'created_at', r.created_at)), '[]'::jsonb)
						FROM contract_fx_period_rates r WHERE r.contract_id = c.id AND r.holding_id = c.holding_id) AS fx_rates,
					c.churn_date::text AS contract_churn_date,
					public.get_cutoff_date(c.holding_id, c.company_id)::text AS cutoff_date
				FROM contracts c
				LEFT JOIN companies co ON co.id = c.company_id AND co.holding_id = c.holding_id
				LEFT JOIN client_entities ce ON ce.id = c.client_entity_id AND ce.holding_id = c.holding_id
				LEFT JOIN tax_document_types tdt ON tdt.id = c.tax_document_type_id
				WHERE c.id = $1 AND c.holding_id = $2 AND c.deleted_at IS NULL`,
				[contractId, holdingId]
			) as Promise<Row[]>,
			db.query(
				`SELECT ci.id, ci.product_id, ci.product_name, ci.account, ci.item_type, ci.categoria, ci.unit_of_measure,
					ci.quantity, ci.unit_price, ci.price_entry_mode, ci.annual_unit_price, ci.discount_type, ci.discount_value,
					ci.monthly_price, ci.billing_period_price, ci.price, ci.final_price, ci.term_months, ci.billing_frequency, ci.billing_method,
					ci.is_recurring, ci.start_date::text AS start_date, ci.end_date::text AS end_date,
					ci.booking_date::text AS booking_date, ci.churn_date::text AS churn_date,
					ci.related_item_id, ci.renews_item_id, ci.renewed_by_item_id, ci.auto_renew, ci.currency, ci.billing_anchor_day, ${PRICE_COLUMNS}
				FROM contract_items ci
				LEFT JOIN prices p ON p.id = ci.price_id
				WHERE ci.contract_id = $1 AND ci.holding_id = $2
				ORDER BY ci.start_date NULLS LAST, ci.product_name, ci.id`,
				[contractId, holdingId]
			) as Promise<Row[]>,
			db.query(
				`SELECT i.id, i.invoice_number, i.status, i.is_active, COALESCE(i.is_legacy, false) AS is_legacy, i.invoice_type, i.document_type, i.export_type,
					i.issue_date::text AS issue_date, i.due_date::text AS due_date, i.client_entity_id, i.contract_currency, i.invoice_currency,
					i.fx_contract_to_invoice, i.tax_rate, i.amount_contract_currency, i.vat, i.amount_invoice_currency, i.total_invoice_currency,
					i.odoo_invoice_id, i.sent_to_odoo_at, i.client_tax_id, i.credit_reason, i.related_invoice_id, ${voidedSql('i')} AS voided
				FROM invoices i
				WHERE i.contract_id = $1 AND i.holding_id = $2 AND COALESCE(i.is_legacy, false) = false
				ORDER BY i.issue_date, i.id`,
				[contractId, holdingId]
			) as Promise<Row[]>,
			db.query(
				`SELECT ii.id, ii.invoice_id, ii.contract_item_id, ii.product_id, ii.description, ii.quantity, ii.unit_of_measure,
					ii.unit_price_contract_currency, ii.unit_price_invoice_currency, ii.discount_pct,
					ii.subtotal_contract_currency, ii.subtotal_invoice_currency, ii.tax_amount_contract_currency, ii.tax_amount_invoice_currency,
					ii.total_contract_currency, ii.total_invoice_currency,
					ii.billing_period_start::text AS billing_period_start, ii.billing_period_end::text AS billing_period_end, ii.quantity_source,
					ii.visible_line_id, ii.fx_rate_source, ii.contract_currency AS line_currency, ii.fx_contract_to_invoice AS line_fx,
					ii.fx_rate_date::text AS fx_rate_date, ii.description_locked, ii.pricing_breakdown
				FROM invoice_items ii
				JOIN invoices i ON i.id = ii.invoice_id
				WHERE i.contract_id = $1 AND i.holding_id = $2 AND COALESCE(i.is_legacy, false) = false
				ORDER BY ii.billing_period_start, ii.id`,
				[contractId, holdingId]
			) as Promise<Row[]>,
			db.query(
				`SELECT DISTINCT q.contract_item_id FROM quantities q JOIN contract_items ci ON ci.id = q.contract_item_id WHERE ci.contract_id = $1 AND ci.holding_id = $2`,
				[contractId, holdingId]
			) as Promise<Row[]>,
			dto.reason_id
				? (db.query(`SELECT id, name FROM churn_reasons WHERE id = $1 AND holding_id = $2 AND is_active = true`, [
						dto.reason_id,
						holdingId,
					]) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			change.type === 'change_entity' && change.client_entity_id
				? (db.query(
						`SELECT ce.id, ce.legal_name, ce.tax_id, ce.country,
							(ce.client_id = c.client_id OR EXISTS (
								SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = ce.id AND x.client_id = c.client_id AND x.holding_id = c.holding_id)) AS belongs
						FROM client_entities ce CROSS JOIN contracts c
						WHERE ce.id = $1 AND ce.holding_id = $2 AND c.id = $3`,
						[change.client_entity_id, holdingId, contractId]
					) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			productIds.length
				? (db.query(`SELECT id, name FROM products WHERE id = ANY($1::uuid[]) AND holding_id = $2`, [productIds, holdingId]) as Promise<
						Row[]
					>)
				: Promise.resolve([] as Row[]),
			(change.type === 'billing_conditions' || change.type === 'change_entity') && change.tax_document_type_id
				? // El catálogo tiene `active` (no `is_active`); `tax_rate` = tasa del documento (ronda 3 de Configuración).
					(db.query(`SELECT id, code, name, kind, country_code, tax_rate FROM tax_document_types WHERE id = $1 AND active = true`, [
						change.tax_document_type_id,
					]) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			dto.origin?.type === 'quote' && dto.origin.quote_id
				? (db.query(
						`SELECT q.id, q.quote_type, q.currency,
							(EXISTS (SELECT 1 FROM contracts c WHERE c.quote_id = q.id AND c.deleted_at IS NULL)
							 OR EXISTS (SELECT 1 FROM contract_lifecycle_events e WHERE e.holding_id = q.holding_id AND e.metadata->'origin'->>'quote_id' = q.id::text)) AS already_applied
						FROM quotes q WHERE q.id = $1 AND q.holding_id = $2`,
						[dto.origin.quote_id, holdingId]
					) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			metricIds.length
				? (db.query(`SELECT id, status FROM billable_metrics WHERE id = ANY($1::uuid[]) AND holding_id = $2`, [
						metricIds,
						holdingId,
					]) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			loadCatalogPrices(db, catalogIds, holdingId),
			// Líneas de las NC de descuento vigentes de las emitidas del contrato (misma regla que la NC de descuento del 360).
			db.query(CONTRACT_PREVIOUS_DISCOUNTS_SQL, [contractId, holdingId]) as Promise<Row[]>,
			// Consumos registrados del contrato: la cantidad de esas líneas no la reinicia ninguna modificación.
			db.query(
				`SELECT e.contract_item_id, e.period_start::text AS period_start, e.quantity, e.amount_override, e.apply_item_discount, e.is_estimated
				FROM consumption_entries e JOIN contract_items ci ON ci.id = e.contract_item_id
				WHERE ci.contract_id = $1 AND e.holding_id = $2`,
				[contractId, holdingId]
			) as Promise<Row[]>,
			this.loadExtraContext(db, contractId, holdingId, dto),
		]);

		if (!contractRow) throw new NotFoundException('Contrato no encontrado');
		const contract: ChangeContractRow = {
			id: String(contractRow.id),
			contract_number: toText(contractRow.contract_number),
			status: toText(contractRow.status),
			client_id: toText(contractRow.client_id),
			client_entity_id: toText(contractRow.client_entity_id),
			company_id: toText(contractRow.company_id),
			contract_currency: (toText(contractRow.contract_currency) ?? 'USD').toUpperCase(),
			invoice_currency: toText(contractRow.invoice_currency),
			system_currency: toText(contractRow.system_currency),
			company_currency: toText(contractRow.contract_company_currency) ?? toText(contractRow.company_currency),
			fx_invoice_policy: toText(contractRow.fx_invoice_policy),
			fx_company_policy: toText(contractRow.fx_company_policy),
			group_invoices_by_period: contractRow.group_invoices_by_period !== false,
			auto_invoice: contractRow.auto_invoice === true,
			auto_send_to_odoo: contractRow.auto_send_to_odoo === true,
			requires_references_for_billing: contractRow.requires_references_for_billing === true,
			billing_anchor_day: toNullableNumber(contractRow.billing_anchor_day),
			payment_terms: cleanPaymentTerms(parseJson(contractRow.payment_terms)),
			document_type: toText(contractRow.document_type),
			tax_document_type_id: toText(contractRow.tax_document_type_id),
			tax_document_type_kind: toText(contractRow.tax_document_type_kind),
			tax_document_tax_rate: toNullableNumber(contractRow.tax_document_tax_rate),
			invoice_terms_and_conditions: toText(contractRow.invoice_terms_and_conditions),
			total_value: toNullableNumber(contractRow.total_value),
			contract_end_date: toText(contractRow.contract_end_date),
			quote_id: toText(contractRow.quote_id),
			company: {
				legal_name: toText(contractRow.company_legal_name),
				tax_id: toText(contractRow.company_tax_id),
				address: toText(contractRow.company_address),
				country: toText(contractRow.company_country),
				tax_rate: contractRow.company_tax_rate as number | string | null,
				currency: toText(contractRow.company_currency),
			},
			entity: {
				id: toText(contractRow.entity_id),
				legal_name: toText(contractRow.entity_legal_name),
				tax_id: toText(contractRow.entity_tax_id),
				country: toText(contractRow.entity_country),
				payment_terms: cleanPaymentTerms(parseJson(contractRow.entity_payment_terms)),
			},
			fx_invoice_rates: (parseJson(contractRow.fx_invoice_rates) as FxPeriodRate[] | null) ?? [],
			requires_multicurrency_billing: contractRow.requires_multicurrency_billing === true,
			fx_item_rates: (parseJson(contractRow.fx_item_rates) as FxPeriodRate[] | null) ?? [],
			fx_rates: ((parseJson(contractRow.fx_rates) as ContractFxRateRow[] | null) ?? []).map((rate) => ({
				...rate,
				period_start: String(rate.period_start).slice(0, 10),
				period_end: String(rate.period_end).slice(0, 10),
			})),
			churn_date: toText(contractRow.contract_churn_date),
			cutoff_date: toText(contractRow.cutoff_date),
			invoice_description_template: parseStoredTemplate(contractRow.invoice_description_template),
			description_max_chars: descriptionMaxCharsOfRow(contractRow),
		};
		const items: ChangeItemRow[] = itemRows.map((row) => ({
			id: String(row.id),
			product_id: toText(row.product_id),
			product_name: toText(row.product_name),
			account: toText(row.account),
			item_type: toText(row.item_type),
			categoria: toText(row.categoria),
			unit_of_measure: toText(row.unit_of_measure),
			quantity: toNullableNumber(row.quantity),
			unit_price: toNullableNumber(row.unit_price),
			price_entry_mode: toText(row.price_entry_mode),
			annual_unit_price: toNullableNumber(row.annual_unit_price),
			discount_type: toText(row.discount_type),
			discount_value: toNullableNumber(row.discount_value),
			monthly_price: toNullableNumber(row.monthly_price),
			billing_period_price: toNullableNumber(row.billing_period_price),
			price: toNullableNumber(row.price),
			final_price: toNullableNumber(row.final_price),
			term_months: toNullableNumber(row.term_months),
			billing_frequency: toText(row.billing_frequency),
			billing_method: toText(row.billing_method),
			is_recurring: row.is_recurring !== false,
			start_date: toText(row.start_date),
			end_date: toText(row.end_date),
			booking_date: toText(row.booking_date),
			churn_date: toText(row.churn_date),
			related_item_id: toText(row.related_item_id),
			renews_item_id: toText(row.renews_item_id),
			renewed_by_item_id: toText(row.renewed_by_item_id),
			auto_renew: Boolean(row.auto_renew),
			currency: toText(row.currency),
			price_id: toText(row.price_id),
			billing_anchor_day: toNullableNumber(row.billing_anchor_day),
			raw: row,
		}));
		const linesByInvoice = new Map<string, ChangeInvoiceLineRow[]>();
		const consumptionByKey = new Map(
			(consumptionRows ?? []).map((row) => [
				`${String(row.contract_item_id)}|${String(row.period_start).slice(0, 10)}`,
				{
					quantity: toNumber(row.quantity),
					amount_override: toNullableNumber(row.amount_override),
					apply_item_discount: row.apply_item_discount !== false,
					is_estimated: row.is_estimated === true,
				},
			])
		);

		for (const row of lineRows) {
			const invoiceId = String(row.invoice_id);
			const line: ChangeInvoiceLineRow = {
				id: String(row.id),
				invoice_id: invoiceId,
				contract_item_id: toText(row.contract_item_id),
				product_id: toText(row.product_id),
				description: toText(row.description),
				quantity: toNumber(row.quantity),
				unit_price: toNumber(row.unit_price_contract_currency),
				unit_price_invoice: toNullableNumber(row.unit_price_invoice_currency),
				discount_pct: toNumber(row.discount_pct),
				subtotal: toNumber(row.subtotal_contract_currency),
				subtotal_invoice: toNullableNumber(row.subtotal_invoice_currency),
				tax_amount: toNumber(row.tax_amount_contract_currency),
				tax_amount_invoice: toNullableNumber(row.tax_amount_invoice_currency),
				total: toNumber(row.total_contract_currency),
				total_invoice: toNullableNumber(row.total_invoice_currency),
				billing_period_start: toText(row.billing_period_start),
				billing_period_end: toText(row.billing_period_end),
				unit_of_measure: toText(row.unit_of_measure),
				quantity_source: toText(row.quantity_source),
				visible_line_id: toText(row.visible_line_id),
				fx_rate_source: toText(row.fx_rate_source),
				// Multimoneda: moneda de origen y tasa de la línea (su par); la NC espejo y las modificaciones las reusan.
				currency: toText(row.line_currency),
				fx: toNullableNumber(row.line_fx),
				fx_rate_date: toText(row.fx_rate_date),
				description_locked: row.description_locked === true,
				pricing_breakdown: Array.isArray(row.pricing_breakdown) ? (row.pricing_breakdown as PricedSubline[]) : null,
				consumption:
					consumptionByKey.get(`${toText(row.contract_item_id) ?? ''}|${toText(row.billing_period_start)?.slice(0, 10) ?? ''}`) ?? null,
			};

			linesByInvoice.set(invoiceId, [...(linesByInvoice.get(invoiceId) ?? []), line]);
		}
		const invoices: ChangeInvoiceRow[] = invoiceRows.map((row) => ({
			id: String(row.id),
			invoice_number: toText(row.invoice_number),
			status: toText(row.status),
			is_active: row.is_active !== false,
			is_legacy: row.is_legacy === true,
			invoice_type: toText(row.invoice_type),
			document_type: toText(row.document_type),
			export_type: toNullableNumber(row.export_type),
			issue_date: toText(row.issue_date),
			due_date: toText(row.due_date),
			client_entity_id: toText(row.client_entity_id),
			contract_currency: toText(row.contract_currency),
			invoice_currency: toText(row.invoice_currency),
			fx: toNullableNumber(row.fx_contract_to_invoice),
			// IVA en porcentaje entero: las Por Emitir del front viejo pueden traer la escala 0,19 de la compañía (Tanda 2).
			tax_rate: normalizeTaxRate(row.tax_rate as number | string | null) ?? 0,
			subtotal: toNumber(row.amount_contract_currency),
			vat: toNumber(row.vat),
			amount_invoice: toNullableNumber(row.amount_invoice_currency),
			total_invoice: toNullableNumber(row.total_invoice_currency),
			lines: linesByInvoice.get(String(row.id)) ?? [],
			odoo_invoice_id: toNullableNumber(row.odoo_invoice_id),
			sent_to_odoo_at: row.sent_to_odoo_at instanceof Date ? row.sent_to_odoo_at.toISOString() : toText(row.sent_to_odoo_at),
			voided: row.voided === true,
			client_tax_id: toText(row.client_tax_id),
			credit_reason: toText(row.credit_reason),
			related_invoice_id: toText(row.related_invoice_id),
		}));

		assignPreviousCredits(invoices, creditedRows ?? []);
		const [reason] = reasonRows;
		const [entity] = entityRows;
		const [taxDoc] = taxDocRows;
		const [quote] = quoteRows;
		const companyCountry = normalizeCountry(contract.company.country);
		const taxDocAllowed =
			taxDoc &&
			(toText(taxDoc.country_code) === '*' || !companyCountry || toText(taxDoc.country_code) === companyCountry) &&
			['invoice', 'export_invoice'].includes(toText(taxDoc.kind) ?? '');

		return {
			contract,
			items,
			invoices,
			quantity_override_item_ids: overrideRows.map((row) => String(row.contract_item_id)),
			churn_reason: reason ? { id: String(reason.id), name: toText(reason.name) ?? '' } : null,
			new_entity: entity
				? {
						id: String(entity.id),
						legal_name: toText(entity.legal_name),
						tax_id: toText(entity.tax_id),
						country: toText(entity.country),
						belongs_to_client: entity.belongs === true,
					}
				: null,
			products: new Map(productRows.map((row) => [String(row.id), String(row.name ?? '')])),
			tax_document_type: taxDocAllowed
				? {
						id: String(taxDoc.id),
						code: toText(taxDoc.code) ?? '',
						name: toText(taxDoc.name) ?? '',
						kind: toText(taxDoc.kind) ?? '',
						tax_rate: toNullableNumber(taxDoc.tax_rate),
					}
				: null,
			quote: quote
				? {
						id: String(quote.id),
						quote_type: toText(quote.quote_type),
						already_applied: quote.already_applied === true,
						currency: toText(quote.currency),
					}
				: null,
			billable_metrics: new Map(metricRows.map((row) => [String(row.id), toText(row.status) ?? ''])),
			catalog_prices: catalogPrices,
			...extra,
			today,
		};
	}

	/**
	 * Contexto del bloque B2 (§9.3): pactos del contrato y series de sus índices, razón social por identificador tributario (`new_entity`),
	 * ítems de la cotización de origen, eventos de baja y otros contratos del cliente (`reactivate`).
	 */
	private async loadExtraContext(
		db: Queryable,
		contractId: string,
		holdingId: string,
		dto: ContractChangeRequestDto
	): Promise<
		Pick<
			ChangeContext,
			| 'scheduled_changes'
			| 'index_series'
			| 'entity_lookup'
			| 'quote_items'
			| 'churn_events'
			| 'client_contracts'
			| 'pauses'
			| 'renewal_proposal'
		>
	> {
		const change = dto.change;
		const pacts = await loadScheduledChanges(db, contractId, holdingId);
		const indexCodes = [...new Set(pacts.filter((pact) => pact.kind === 'index' && pact.index_code).map((pact) => pact.index_code!))];
		const quoteId = dto.origin?.type === 'quote' ? dto.origin.quote_id : null;
		const proposalId = dto.origin?.type === 'renewal_proposal' ? (dto.origin.event_id ?? null) : null;
		const [indexRows, entityRows, quoteRows, eventRows, clientRows, pauseRows, proposalRows] = await Promise.all([
			indexCodes.length
				? (db.query(`SELECT codigo, fecha::text AS fecha, valor FROM indicadores_economicos WHERE codigo = ANY($1::text[]) ORDER BY fecha`, [
						indexCodes,
					]) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			change.type === 'change_entity' && change.new_entity?.tax_id
				? (db.query(
						`SELECT ce.id, ce.legal_name, ce.tax_id, ce.country,
							(ce.client_id = c.client_id OR EXISTS (
								SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = ce.id AND x.client_id = c.client_id AND x.holding_id = c.holding_id)) AS belongs
						FROM client_entities ce CROSS JOIN contracts c
						WHERE ce.holding_id = $1 AND c.id = $2
							AND lower(regexp_replace(ce.tax_id, '[^0-9kK]', '', 'g')) = lower(regexp_replace($3, '[^0-9kK]', '', 'g'))
						ORDER BY belongs DESC, ce.id LIMIT 1`,
						[holdingId, contractId, change.new_entity.tax_id]
					) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			quoteId
				? (db.query(
						`SELECT qi.id, qi.quote_id, qi.product_id, qi.product_name, qi.account, qi.item_type, qi.unit_of_measure, qi.quantity,
							qi.unit_price, qi.annual_unit_price, qi.price_entry_mode, qi.discount_value, qi.billing_frequency, qi.billing_method,
							qi.start_date::text AS start_date, qi.is_recurring, COALESCE(qi.currency, q.currency) AS currency, ${PRICE_COLUMNS}
						FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id
						LEFT JOIN prices p ON p.id = qi.price_id
						WHERE qi.quote_id = $1 AND qi.holding_id = $2`,
						[quoteId, holdingId]
					) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			change.type === 'reactivate'
				? (db.query(
						`SELECT id, event_type, items_affected, effective_date::text AS effective_date, (metadata ? 'reversed_by') AS reversed
						FROM contract_lifecycle_events WHERE contract_id = $1 AND holding_id = $2 AND event_type IN ('CHURN', 'DOWNSELL')
						ORDER BY created_at DESC`,
						[contractId, holdingId]
					) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			change.type === 'reactivate'
				? (db.query(
						`SELECT o.status, o.churn_date::text AS churn_date,
							COALESCE((SELECT array_agg(DISTINCT oi.product_id::text) FROM contract_items oi WHERE oi.contract_id = o.id), '{}') AS product_ids
						FROM contracts c JOIN contracts o ON o.client_id = c.client_id AND o.holding_id = c.holding_id AND o.id <> c.id AND o.deleted_at IS NULL
						WHERE c.id = $1 AND c.holding_id = $2`,
						[contractId, holdingId]
					) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			// §9.3.3: pausas de los ítems (estado derivado, MRR, pausar y reanudar).
			db.query(
				`SELECT id, contract_item_id, pause_start::text AS pause_start, pause_end::text AS pause_end, extend_term, status, reason
				FROM contract_item_pauses WHERE contract_id = $1 AND holding_id = $2 ORDER BY pause_start, id`,
				[contractId, holdingId]
			) as Promise<Row[]>,
			// §9.3.5: propuesta de renovación que se confirma.
			proposalId
				? (db.query(
						`SELECT id, COALESCE(metadata->>'status', 'open') AS status, metadata->'items' AS items
						FROM contract_lifecycle_events WHERE id = $1 AND contract_id = $2 AND holding_id = $3 AND event_type = 'RENEWAL_PROPOSED'`,
						[proposalId, contractId, holdingId]
					) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
		]);
		const series = new Map<string, Array<{ date: string; value: number }>>();

		for (const row of indexRows ?? []) {
			const code = String(row.codigo);

			series.set(code, [...(series.get(code) ?? []), { date: String(row.fecha).slice(0, 10), value: toNumber(row.valor) }]);
		}
		const [entity] = entityRows ?? [];
		const [proposal] = proposalRows ?? [];
		const proposalItems = parseJson(proposal?.items);

		return {
			pauses: (pauseRows ?? []).map(
				(row): ItemPauseRow => ({
					id: String(row.id),
					contract_item_id: String(row.contract_item_id),
					pause_start: String(row.pause_start).slice(0, 10),
					pause_end: toText(row.pause_end)?.slice(0, 10) ?? null,
					extend_term: row.extend_term === true,
					status: toText(row.status) ?? 'active',
					reason: toText(row.reason),
				})
			),
			renewal_proposal: proposal
				? {
						id: String(proposal.id),
						status: toText(proposal.status) ?? 'open',
						item_ids: Array.isArray(proposalItems) ? (proposalItems as Row[]).map((item) => String(item.item_id)) : [],
					}
				: null,
			scheduled_changes: pacts,
			index_series: series,
			entity_lookup: entity
				? {
						id: String(entity.id),
						legal_name: toText(entity.legal_name),
						tax_id: toText(entity.tax_id),
						country: toText(entity.country),
						belongs_to_client: entity.belongs === true,
					}
				: null,
			quote_items: new Map(
				(quoteRows ?? []).map((row) => {
					const annual = toText(row.price_entry_mode) === 'annual';

					return [
						String(row.id),
						{
							id: String(row.id),
							quote_id: String(row.quote_id),
							product_id: toText(row.product_id),
							product_name: toText(row.product_name),
							account: toText(row.account),
							item_type: toText(row.item_type),
							unit_of_measure: toText(row.unit_of_measure),
							quantity: toNullableNumber(row.quantity),
							unit_price: annual ? toNumber(row.annual_unit_price) / 12 : toNullableNumber(row.unit_price),
							annual_unit_price: toNullableNumber(row.annual_unit_price),
							price_entry_mode: toText(row.price_entry_mode),
							discount_value: toNullableNumber(row.discount_value),
							billing_frequency: toText(row.billing_frequency),
							billing_method: toText(row.billing_method),
							start_date: toText(row.start_date)?.slice(0, 10) ?? null,
							is_recurring: row.is_recurring !== false,
							currency: toText(row.currency)?.toUpperCase() ?? null,
							price_spec: row.price_id ? priceSpecFromRow(row) : null,
						},
					];
				})
			),
			churn_events: (eventRows ?? []).map((row) => {
				const affected = parseJson(row.items_affected);

				return {
					id: String(row.id),
					event_type: String(row.event_type),
					items_affected: Array.isArray(affected) ? affected.map(String) : [],
					effective_date: toText(row.effective_date),
					reversed: row.reversed === true,
				};
			}),
			client_contracts: (clientRows ?? []).map((row) => ({
				status: toText(row.status),
				churn_date: toText(row.churn_date)?.slice(0, 10) ?? null,
				product_ids: Array.isArray(row.product_ids) ? (row.product_ids as unknown[]).map(String) : [],
			})),
		};
	}
}

/** Ajustes de la NC espejo según quién la pide: motivo del catálogo (`credit_reason`) y sufijo de la glosa de cada línea. */
/**
 * Referencia de la NC a su factura (como la NC electrónica: tipo y folio del documento original, código SII del motivo: 1 = anula,
 * 3 = corrige montos) y cierre de la original al anular (`Cancelada`, como la función legacy `cancel_invoice_with_credit_note`): sale
 * de vencimientos y cobranza y queda neteada. Decisión de Domi 01-10.
 */
export const NC_REFERENCE_CODES = { cancellation: '1', discount: '3' } as const;
const ORIGINAL_DOCUMENT_CODE_SQL = `SELECT COALESCE(t.code, CASE WHEN i.document_type = 'FACTURA_EXPORTACION' THEN '110' ELSE '33' END) AS code,
		COALESCE(t.name, 'Factura electrónica') AS name
	FROM invoices i LEFT JOIN contracts c ON c.id = i.contract_id LEFT JOIN tax_document_types t ON t.id = c.tax_document_type_id
	WHERE i.id = $1 AND i.holding_id = $2`;

export async function insertCreditNoteReference(
	runner: QueryRunner,
	creditNoteId: string,
	original: { id: string; invoice_number: string | null; issue_date: string | null },
	holdingId: string,
	kind: keyof typeof NC_REFERENCE_CODES,
	reason: string,
	userId: string | null
): Promise<void> {
	const [doc] = (await runner.query(ORIGINAL_DOCUMENT_CODE_SQL, [original.id, holdingId])) as Row[];

	await runner.query(
		`INSERT INTO invoice_references (invoice_id, holding_id, document_number, document_type_code, document_type_name, reference_code, reason, reference_date, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9)`,
		[
			creditNoteId,
			holdingId,
			original.invoice_number ?? original.id,
			toText(doc?.code) ?? '33',
			toText(doc?.name) ?? 'Factura electrónica',
			NC_REFERENCE_CODES[kind],
			reason,
			original.issue_date,
			userId,
		]
	);
}

export interface MirrorCreditNoteOptions {
	/** `downsell` (default), `churn`, `issue_error` (reemisión por consumo corregido), etc.; CHECK `invoices_credit_reason_check`. */
	credit_reason?: string;
	/** `discount` (default, NC parcial) o `cancellation` (anula la emitida completa); CHECK `invoices_credit_type_check`. */
	credit_type?: 'discount' | 'cancellation';
	line_suffix?: (periodStart: string) => string;
	/** Devengo de una NC de descuento (`impact_month` | `defer_forward` | `service_period`); NULL en anulación y en modificaciones. */
	nc_revenue_treatment?: string | null;
	/** `Automatica` (default: modificaciones y consumo) o `Manual` (la pidió la usuaria desde el 360, como `create_credit_note_safe`). */
	invoice_type?: 'Automatica' | 'Manual';
	/** Anulación completa: cada línea copia su IVA guardado (NC al centavo, `mirrorCreditNoteAmounts`). */
	exact?: boolean;
	/**
	 * Forma de la línea: `mirror` (default) = misma cantidad y unitario negativo (espejo); `amount` = cantidad 1 y unitario = −monto (NC de
	 * descuento parcial, como el patrón NC32 de `create_credit_note_safe`).
	 */
	line_shape?: 'mirror' | 'amount';
	/**
	 * Forma de las líneas con `ratio` ≠ 1 cuando `line_shape` es `mirror`: `amount` = cantidad 1 y unitario = −monto (la anulación que
	 * acredita solo lo que queda de una línea ya descontada por NC previas). Sin valor = la forma de `line_shape`.
	 */
	partial_line_shape?: 'amount';
	/**
	 * Fila `invoice_references` a la factura acreditada (tipo y folio del original, código SII del motivo). Anular y la NC de descuento del
	 * 360 la escriben ellos con su glosa; modificaciones y consumo la piden aquí.
	 */
	reference?: { kind: keyof typeof NC_REFERENCE_CODES; reason: string; user_id?: string | null };
}

/**
 * Línea del documento de una factura por OC dentro de la NC (spec facturas §3.7b/§3.8): cantidad 1, unitario = −Σ de lo que la NC acredita
 * en sus internas (en ambas monedas; null en moneda de factura si alguna interna no la tiene) y montos en 0, igual que la visible original
 * (Σ líneas = encabezado sin duplicar). Así el ERP recibe una línea con la parte acreditada del documento emitido y Sapira las internas.
 */
export function mirrorVisibleLineAmounts(
	visibleId: string,
	lines: Array<{ line: Pick<ChangeInvoiceLineRow, 'id' | 'visible_line_id'> }>,
	amounts: Array<{ subtotal: number; subtotal_invoice: number | null }>
): { unit_price: number; unit_price_invoice: number | null } {
	const linked = lines.map((entry, index) => ({ entry, amount: amounts[index] })).filter(({ entry }) => entry.line.visible_line_id === visibleId);
	const unitPrice = round2(linked.reduce((sum, { amount }) => sum + amount.subtotal, 0));
	const unitPriceInvoice = linked.some(({ amount }) => amount.subtotal_invoice === null)
		? null
		: round2(linked.reduce((sum, { amount }) => sum + (amount.subtotal_invoice ?? 0), 0));

	return { unit_price: -unitPrice, unit_price_invoice: unitPriceInvoice === null ? null : -unitPriceInvoice };
}

/**
 * NC espejo exacto de la emitida (ROADMAP #10, mapa M2): misma moneda, FX, IVA, receptor y emisor; por cada línea, la parte
 * indicada por `ratio` (1 = completa) con montos negativos, conservando ítem y período (así `nc_discount_revenue_adjustment` la atribuye).
 * Nace siempre `Emitida` (`creditNoteStatusFor`: nunca Pagada/Vencida ni Por Emitir; emisión electrónica pendiente) y **sin vencimiento** (`due_date` NULL: una NC no vence, se cierra con su factura; decisión de
 * Domi 30-09). **Nunca toca la emitida**. La usan las modificaciones (baja/downsell prorrateados), el consumo (`on_issued = reissue`, spec
 * pricing §4.4) y el 360 (anular y reemitir, NC de descuento parcial; spec facturas §3.8). Factura por OC: la NC refleja TODAS sus líneas,
 * la visible del documento (cantidad 1, unitario = Σ acreditado en sus internas, `mirrorVisibleLineAmounts`) y las internas ligadas a ella
 * por `visible_line_id` (el ERP recibe una línea igual al documento emitido y Sapira conserva el detalle por ítem y período).
 */
export async function insertMirrorCreditNote(
	runner: QueryRunner,
	mirrors: Pick<ChangeInvoiceRow, 'id' | 'tax_rate'>,
	lines: Array<{ line: ChangeInvoiceLineRow; ratio: number; period_start: string }>,
	note: string,
	holdingId: string,
	effectiveDate: string,
	options: MirrorCreditNoteOptions = {}
): Promise<string> {
	const [original] = (await runner.query(
		`SELECT company_id, client_id, client_entity_id, contract_id, contract_currency, invoice_currency, system_currency, fx_contract_to_invoice, fx_contract_to_system,
			issuer_tax_id, issuer_legal_name, issuer_address, client_tax_id, payment_method, fiscal_regime, export_type, tax_rate, invoice_series,
			status, invoice_number, issue_date::text AS issue_date
		FROM invoices WHERE id = $1 AND holding_id = $2`,
		[mirrors.id, holdingId]
	)) as Row[];

	if (!original) throw new NotFoundException(`La factura ${mirrors.id} ya no existe`);
	const creditNoteStatus = creditNoteStatusFor();
	const computed = mirrorCreditNoteAmounts(lines, mirrors.tax_rate, options.exact === true);
	const amounts = computed.lines;
	// Multimoneda (spec-multimoneda §4 "Notas de crédito"): cada línea de la NC reusa la moneda y la tasa de SU línea original (par, origen y
	// fecha de la tasa), nunca las del encabezado; el encabezado en moneda de contrato = Σ líneas × tasa pactada ítem → contrato.
	const originals = ((await runner.query(
		`SELECT id, contract_currency, fx_contract_to_invoice, fx_rate_source, fx_rate_date::text AS fx_rate_date
		FROM invoice_items WHERE invoice_id = $1 AND holding_id = $2`,
		[mirrors.id, holdingId]
	)) ?? []) as Row[];
	const originalLine = new Map(originals.map((row) => [String(row.id), row]));
	const headerCurrency = upperCode(original.contract_currency);
	const multicurrency = originals.some((row) => Boolean(row.contract_currency) && upperCode(row.contract_currency) !== headerCurrency);

	if (multicurrency) {
		const itemRates = ((await runner.query(
			`SELECT from_currency, to_currency, rate, period_start::text AS period_start, period_end::text AS period_end, created_at
			FROM contract_fx_period_rates WHERE contract_id = $1 AND holding_id = $2 AND purpose = 'item'`,
			[original.contract_id, holdingId]
		)) ?? []) as FxPeriodRate[];
		let subtotal = 0;
		let tax = 0;

		lines.forEach(({ line, period_start: periodStart }, index) => {
			const rate =
				itemRate(itemRates, toText(originalLine.get(line.id)?.contract_currency) ?? headerCurrency, headerCurrency, periodStart) ?? 0;

			subtotal += round2(amounts[index].subtotal * rate);
			tax += round2(amounts[index].tax * rate);
		});
		computed.header.amount_contract_currency = -round2(subtotal);
		if (computed.header.amount_invoice_currency === null) computed.header.vat = -round2(tax);
	}
	// Costura: la API escribe el grupo (el de la factura espejada, antes `assign_invoice_group_id`), las condiciones del contrato
	// (antes `invoices_fill_terms_from_contract`) y, al final, los montos en moneda del sistema.
	const [header] = (await runner.query(
		`INSERT INTO invoices (
			invoice_group_id, invoice_terms_and_conditions,
			holding_id, contract_id, company_id, client_id, client_entity_id,
			scheduled_at, original_issue_date, issue_date, due_date, status,
			contract_currency, invoice_currency, system_currency,
			amount_contract_currency, amount_invoice_currency, vat, total_invoice_currency,
			fx_contract_to_invoice, fx_contract_to_system,
			invoice_type, document_type, related_invoice_id, credit_type, credit_reason, nc_revenue_treatment,
			issuer_tax_id, issuer_legal_name, issuer_address, client_tax_id, payment_method, fiscal_regime, export_type, tax_rate, invoice_series, notes, is_active
		) VALUES (
			(SELECT COALESCE(r.invoice_group_id, r.id) FROM invoices r WHERE r.id = $17::uuid), ${invoiceTermsSql(2)},
			$1, $2, $3, $4, $5,
			$6, $6, $6, NULL, $7,
			$8, $9, $10,
			$11, $12, $13, $14,
			$15, $16,
			$31, 'NC', $17, $29, $18, $30,
			$19, $20, $21, $22, $23, $24, $25, $26, $27, $28, true
		) RETURNING id`,
		[
			holdingId,
			original.contract_id,
			original.company_id,
			original.client_id,
			original.client_entity_id,
			effectiveDate,
			creditNoteStatus,
			original.contract_currency,
			original.invoice_currency,
			original.system_currency,
			computed.header.amount_contract_currency,
			computed.header.amount_invoice_currency,
			computed.header.vat,
			computed.header.total_invoice_currency,
			original.fx_contract_to_invoice,
			original.fx_contract_to_system,
			mirrors.id,
			options.credit_reason ?? 'downsell',
			original.issuer_tax_id,
			original.issuer_legal_name,
			original.issuer_address,
			original.client_tax_id,
			original.payment_method,
			original.fiscal_regime,
			original.export_type,
			// IVA normalizado (el mismo con que se calcularon las líneas de la NC).
			mirrors.tax_rate,
			original.invoice_series,
			note,
			options.credit_type ?? 'discount',
			options.nc_revenue_treatment ?? null,
			options.invoice_type ?? 'Automatica',
		]
	)) as Row[];
	const creditNoteId = String(header.id);
	const lineIds: string[] = [];
	const visibleIds = new Set(lines.map(({ line }) => line.visible_line_id).filter((id): id is string => !!id));

	for (const [index, { line, period_start, ratio }] of lines.entries()) {
		const amount = amounts[index];
		const document = visibleIds.has(line.id) ? mirrorVisibleLineAmounts(line.id, lines, amounts) : null;
		const byAmount = !document && (options.line_shape === 'amount' || (options.partial_line_shape === 'amount' && ratio !== 1));
		const source = originalLine.get(line.id);

		// Con la costura la línea nace con su ítem (sin patrón B: `standardize_invoice_items` no corre para la API).
		const [row] = (await runner.query(
			`INSERT INTO invoice_items (
				contract_item_id, holding_id, invoice_id, contract_id, product_id, description, quantity, unit_of_measure,
				unit_price_contract_currency, unit_price_invoice_currency, discount_pct,
				subtotal_contract_currency, subtotal_invoice_currency, tax_amount_contract_currency, tax_amount_invoice_currency,
				total_contract_currency, total_invoice_currency, contract_currency, invoice_currency, fx_contract_to_invoice, fx_rate_source,
				status, issue_date, billing_period_start, billing_period_end, fx_rate_date
			) VALUES (
				$25::uuid, $1, $2, $3, $4, $5, $6, $7,
				$8, $9, $10,
				$11, $12, $13, $14,
				$15, $16, $17, $18, $19, $20,
				$21, $22, $23, $24, $26::date
			) RETURNING id`,
			[
				holdingId,
				creditNoteId,
				original.contract_id,
				line.product_id,
				`${line.description ?? ''}${options.line_suffix ? options.line_suffix(period_start) : ` (NC espejo de la factura ${mirrors.id})`}`.trim(),
				byAmount || document ? 1 : line.quantity,
				line.unit_of_measure ?? 'UND',
				document ? document.unit_price : byAmount ? -amount.subtotal : -line.unit_price,
				document
					? document.unit_price_invoice
					: byAmount
						? amount.subtotal_invoice === null
							? null
							: -amount.subtotal_invoice
						: line.unit_price_invoice === null
							? null
							: -line.unit_price_invoice,
				byAmount || document ? 0 : line.discount_pct,
				-amount.subtotal,
				amount.subtotal_invoice === null ? null : -amount.subtotal_invoice,
				-amount.tax,
				amount.tax_invoice === null ? null : -amount.tax_invoice,
				-round2(amount.subtotal + amount.tax),
				amount.subtotal_invoice === null ? null : -round2(amount.subtotal_invoice + (amount.tax_invoice ?? 0)),
				multicurrency ? (toText(source?.contract_currency) ?? original.contract_currency) : original.contract_currency,
				original.invoice_currency,
				multicurrency
					? source
						? toNullableNumber(source.fx_contract_to_invoice)
						: original.fx_contract_to_invoice
					: original.fx_contract_to_invoice,
				multicurrency ? (toText(source?.fx_rate_source) ?? null) : CHANGES_FX_RATE_SOURCE,
				creditNoteStatus,
				effectiveDate,
				period_start,
				line.billing_period_end,
				line.contract_item_id ?? null,
				multicurrency ? (toText(source?.fx_rate_date)?.slice(0, 10) ?? null) : null,
			]
		)) as Row[];

		lineIds.push(row?.id === undefined || row?.id === null ? '' : String(row.id));
	}
	// Líneas internas de facturar por OC: la NC conserva el vínculo interna → visible (espejo de la visible).
	const mirrorOf = new Map(lines.map(({ line }, index) => [line.id, lineIds[index]]));

	for (const [index, { line }] of lines.entries()) {
		const visible = line.visible_line_id ? mirrorOf.get(line.visible_line_id) : undefined;

		if (visible && lineIds[index])
			await runner.query(`UPDATE invoice_items SET visible_line_id = $3 WHERE id = $1 AND holding_id = $2`, [
				lineIds[index],
				holdingId,
				visible,
			]);
	}
	// Montos en moneda del sistema con la tasa de la original (ROADMAP #10: la NC replica la original, no la fecha de la NC).
	await mirrorInvoiceSystemAmounts(runner, holdingId, creditNoteId, mirrors.id);
	if (options.reference)
		await insertCreditNoteReference(
			runner,
			creditNoteId,
			{ id: mirrors.id, invoice_number: toText(original.invoice_number), issue_date: toText(original.issue_date)?.slice(0, 10) ?? null },
			holdingId,
			options.reference.kind,
			options.reference.reason,
			options.reference.user_id ?? null
		);

	return creditNoteId;
}
