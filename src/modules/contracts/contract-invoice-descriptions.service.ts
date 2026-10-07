import { randomUUID } from 'crypto';

import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { type FieldError, validationException } from '@/core/utils/validation-errors';

import { setApiWriter } from './api-writer';
import { PENDING_STATUS, unifiedV2Sql } from './contract-360';
import { resolveUserId } from './contract-drafts.service';
import {
	type ContractInvoiceRow,
	descriptionBlockers,
	INVOICE_EVENT_TYPES,
	type InvoiceBlocker,
	type InvoiceReferenceRow,
	planReferences,
} from './contract-invoices';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractsService } from './contracts.service';
import {
	DESCRIPTION_FITTED_CODE,
	type DescriptionContext,
	type DescriptionLineInput,
	type DescriptionLinePlan,
	type DescriptionReference,
	type DescriptionTemplate,
	effectiveTemplate,
	exceedsMax,
	fitDescription,
	isPerTierBreakdown,
	normalizeTemplate,
	parseStoredTemplate,
	planDescriptions,
	referenceKind,
	tierLabelFromBreakdown,
	validateTemplate,
} from './invoice-description';
import { DESCRIPTION_LIMITS_SQL, type DescriptionLimitRow, resolveDescriptionMaxChars } from './tax-document-types';

import type {
	PreviewDescriptionTemplateDto,
	SaveDescriptionTemplateDto,
	UpdateInvoiceDescriptionsDto,
	UpdateInvoiceReferencesDto,
} from './dtos/contract-invoice-descriptions.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNullableNumber = (value: unknown) => (value === null || value === undefined || value === '' ? null : Number(value) || 0);
const parseJson = <T>(value: unknown): T | null => {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') return value as T;
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
};

/** Contrato con lo que necesita el constructor: plantilla guardada y límite de caracteres de su documento. */
interface DescriptionContract {
	id: string;
	template: DescriptionTemplate | null;
	max_chars: number | null;
}

/** Una línea existente con su factura y los datos para renderizar su glosa. */
interface DescriptionLineRow {
	line_id: string;
	invoice_id: string;
	description: string | null;
	locked: boolean;
	/** `quantity_source = manual` (línea editada a mano, spec §3.4). */
	manual: boolean;
	/** Visible del documento de una factura por OC (alguna línea interna la apunta con `visible_line_id`). */
	po_visible: boolean;
	context: DescriptionContext;
}

interface DescriptionEvent {
	type: string;
	title: string;
	description: string;
	invoice_id: string | null;
	metadata: Record<string, unknown>;
}

/** Las líneas se leen en el orden del detalle de factura (filas de un mismo ítem juntas, tramos en su orden). */
const LINES_SELECT = `SELECT ii.id, ii.invoice_id, ii.description, ii.description_locked, ii.quantity, ii.unit_of_measure, ii.quantity_source,
		ii.unit_price_contract_currency, ii.subtotal_contract_currency, ii.pricing_breakdown,
		ii.billing_period_start::text AS billing_period_start, ii.billing_period_end::text AS billing_period_end,
		ci.product_name, ci.account, p.model AS price_model, p.quantity_type AS price_quantity_type,
		-- Multimoneda (spec-multimoneda §4 "Glosa"): el bloque de tipo de cambio toma la moneda y la tasa DE LA LÍNEA (su par); sin el flag, las
		-- del encabezado como siempre.
		CASE WHEN c.requires_multicurrency_billing IS TRUE THEN COALESCE(ii.contract_currency, i.contract_currency) ELSE i.contract_currency END AS contract_currency,
		i.invoice_currency,
		CASE WHEN c.requires_multicurrency_billing IS TRUE THEN ii.fx_contract_to_invoice ELSE i.fx_contract_to_invoice END AS fx_contract_to_invoice,
		ce.legal_name, c.contract_number,
		EXISTS (SELECT 1 FROM invoice_items vi WHERE vi.visible_line_id = ii.id) AS po_visible,
		(SELECT COALESCE(jsonb_agg(jsonb_build_object('type', x.type, 'name', x.name, 'code', x.code)), '[]'::jsonb) FROM (
			SELECT r.document_type_code AS type, r.document_type_name AS name, r.document_number AS code FROM invoice_references r WHERE r.invoice_id = i.id
			UNION ALL
			SELECT br.reference_type::text, NULL, br.reference_code FROM invoice_reference_links rl JOIN billing_references br ON br.id = rl.reference_id
			WHERE rl.invoice_id = i.id
		) x) AS references
	FROM invoice_items ii
	JOIN invoices i ON i.id = ii.invoice_id
	JOIN contracts c ON c.id = i.contract_id AND c.holding_id = i.holding_id
	LEFT JOIN contract_items ci ON ci.id = ii.contract_item_id
	LEFT JOIN prices p ON p.id = ci.price_id
	LEFT JOIN client_entities ce ON ce.id = i.client_entity_id`;
const LINES_ORDER = `ORDER BY i.issue_date NULLS LAST, i.created_at, i.id, ii.billing_period_start NULLS LAST, ci.product_name NULLS LAST, ci.account NULLS FIRST,
		ii.contract_item_id, CASE WHEN jsonb_typeof(ii.pricing_breakdown) = 'array' THEN (ii.pricing_breakdown->0->>'line_index')::int END NULLS FIRST,
		ii.created_at, ii.id`;

/**
 * Facturas en el Contrato 360, etapa 3 (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.6, §3.7a): constructor de descripción
 * (plantilla por contrato con vista previa y contador contra el límite del documento, regeneración masiva, texto manual protegido con
 * `description_locked` y "volver a la plantilla") y referencias OC/HES por factura. Cada escritura va en **una transacción** con
 * `setApiWriter` (`sapira.writer = 'api'`) como primera sentencia y el contrato bloqueado (`FOR UPDATE`), con evento en
 * `contract_lifecycle_events`. Sin RSM: ni la glosa ni las referencias cambian montos ni períodos.
 */
@Injectable()
export class ContractInvoiceDescriptionsService {
	private readonly logger = new Logger(ContractInvoiceDescriptionsService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly contracts: ContractsService,
		private readonly invoices: ContractInvoicesService
	) {}

	// ---------------------------------------------------------------- plantilla del contrato

	/** Plantilla efectiva (propia o la estándar), límite del documento y una muestra con la primera línea de la próxima Por Emitir. */
	async getTemplate(idOrNumber: string, holdingId: string) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const context = await this.loadContract(this.dataSource, contract.id, holdingId);
		const { template, is_default } = effectiveTemplate(context.template);
		const sample = await this.sampleLine(this.dataSource, context.id, holdingId);

		return {
			template,
			is_default,
			max_chars: context.max_chars,
			sample: sample ? this.render(template, sample, context.max_chars) : null,
		};
	}

	/** Renderiza una plantilla con una línea real (la pedida o la de muestra), sin guardar nada. */
	async previewTemplate(idOrNumber: string, dto: PreviewDescriptionTemplateDto, holdingId: string) {
		const template = this.validTemplate(dto.template);
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const context = await this.loadContract(this.dataSource, contract.id, holdingId);
		const line = dto.line_id
			? await this.lineById(this.dataSource, context.id, holdingId, dto.line_id)
			: await this.sampleLine(this.dataSource, context.id, holdingId);
		const rendered = line ? this.render(template, line, context.max_chars) : null;

		return {
			line_id: line?.line_id ?? null,
			text: rendered?.text ?? '',
			length: rendered?.length ?? 0,
			max_chars: context.max_chars,
			exceeds: rendered?.exceeds ?? false,
			pending_fields: rendered?.pending_fields ?? [],
			fitted: rendered?.fitted ?? false,
			steps: rendered?.steps ?? [],
		};
	}

	/**
	 * Guarda la plantilla del contrato (`null` = volver a la estándar). La muestra y las líneas regeneradas se ajustan automáticamente al
	 * límite del documento (`fitDescription`); rechaza (400) solo si aun ajustada alguna lo supera. Con `apply_to_pending` regenera las líneas de las Por Emitir activas del contrato que no
	 * están protegidas ni bloqueadas (enviadas al ERP, unificadas, legacy). Evento `CONTRACT_DESCRIPTION_TEMPLATE_CHANGED` con antes/después.
	 */
	async saveTemplate(idOrNumber: string, dto: SaveDescriptionTemplateDto, holdingId: string, authId: string) {
		const next = dto.template === null || dto.template === undefined ? null : this.validTemplate(dto.template);
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.transaction(contract.id, holdingId, async (runner) => {
			const context = await this.loadContract(runner, contract.id, holdingId);
			const sample = await this.sampleLine(runner, context.id, holdingId);
			const rendered = sample ? this.render(next, sample, context.max_chars) : null;

			// Volver a la estándar (null) nunca se bloquea: es la glosa de hoy.
			if (next !== null && rendered?.exceeds) {
				throw validationException([
					{
						field: 'template',
						message: `La descripción de muestra tiene ${rendered.length} caracteres y el documento admite ${context.max_chars}`,
					},
				]);
			}
			let plans: DescriptionLinePlan[] = [];

			// Volver a la estándar (null) nunca se bloquea: es la glosa de hoy (también ajustada al límite).
			if (dto.apply_to_pending) {
				const lines = await this.pendingLines(runner, context.id, holdingId, true);

				plans = planDescriptions(lines, { mode: 'apply_template', contract_template: next, max_chars: context.max_chars });
				if (next !== null) this.rejectExceeding(plans, 'template');
			}
			const applied = plans.filter((plan) => !plan.skipped_reason);
			const skippedLocked = plans.filter((plan) => plan.skipped_reason === 'locked').length;
			const skippedManual = plans.filter((plan) => plan.skipped_reason === 'manual_edit_kept').length;
			const fittedLines = applied.filter((plan) => plan.fitted).length;
			const beforeTemplate = context.template;
			const changed = JSON.stringify(beforeTemplate) !== JSON.stringify(next);

			await runner.query(`UPDATE contracts SET invoice_description_template = $3::jsonb WHERE id = $1 AND holding_id = $2`, [
				context.id,
				holdingId,
				next === null ? null : JSON.stringify(next),
			]);
			await this.writeLines(runner, holdingId, applied);
			if (changed || applied.length) {
				const invoiceIds = [...new Set(applied.map((plan) => plan.invoice_id))];

				await this.insertEvent(runner, context.id, holdingId, userId, {
					type: INVOICE_EVENT_TYPES.description_template,
					title: next ? 'Plantilla de descripción de facturas actualizada' : 'Plantilla de descripción de facturas: vuelve a la estándar',
					description: dto.apply_to_pending
						? `Aplicada a ${applied.length} ${applied.length === 1 ? 'línea' : 'líneas'} de facturas Por Emitir${
								skippedLocked ? ` (${skippedLocked} escritas a mano sin cambios)` : ''
							}`
						: 'Aplica a las facturas que se generen desde ahora',
					invoice_id: null,
					metadata: {
						before: beforeTemplate,
						after: next,
						apply_to_pending: dto.apply_to_pending === true,
						updated_lines: applied.length,
						skipped_locked: skippedLocked,
						skipped_manual: skippedManual,
						fitted_lines: fittedLines,
						invoice_ids: invoiceIds,
						lines: applied.map((plan) => ({
							line_id: plan.line_id,
							invoice_id: plan.invoice_id,
							before: plan.before,
							after: plan.after,
						})),
					},
				});
			}
			const effective = effectiveTemplate(next);
			const warnings: string[] = [];

			if (rendered?.fitted) warnings.push(`La descripción de muestra se ajustó automáticamente: ${rendered.steps.join(', ')}`);
			if (fittedLines) {
				warnings.push(
					`${fittedLines} ${fittedLines === 1 ? 'línea se ajustó' : 'líneas se ajustaron'} automáticamente al límite de ${context.max_chars} caracteres`
				);
			}

			return {
				template: effective.template,
				is_default: effective.is_default,
				updated_lines: applied.length,
				skipped_locked: skippedLocked,
				skipped_manual: skippedManual,
				fitted_lines: fittedLines,
				sample: rendered ? { text: rendered.text, length: rendered.length, fitted: rendered.fitted, steps: rendered.steps } : null,
				warnings,
				warning_codes: warnings.length ? [DESCRIPTION_FITTED_CODE] : [],
			};
		});
	}

	// ---------------------------------------------------------------- descripciones de líneas (selección)

	async previewDescriptions(idOrNumber: string, dto: UpdateInvoiceDescriptionsDto, holdingId: string) {
		const operation = this.validOperation(dto);
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const context = await this.loadContract(this.dataSource, contract.id, holdingId);
		const lines = await this.selectedLines(this.dataSource, context.id, holdingId, dto);

		return this.descriptionsPreview(
			planDescriptions(lines, { ...operation, contract_template: context.template, max_chars: context.max_chars }),
			context
		);
	}

	/**
	 * Aplica el modo a las líneas elegidas (por factura o por línea) de Por Emitir activas del contrato. `set` rechaza (400) si el texto supera
	 * el límite; los demás modos generan la glosa ajustada al límite (`fitDescription`) y solo rechazan si aun así alguna lo supera. Un evento `INVOICE_DESCRIPTIONS_UPDATED` por factura.
	 */
	async updateDescriptions(idOrNumber: string, dto: UpdateInvoiceDescriptionsDto, holdingId: string, authId: string) {
		const operation = this.validOperation(dto);
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.transaction(contract.id, holdingId, async (runner) => {
			const context = await this.loadContract(runner, contract.id, holdingId);
			const lines = await this.selectedLines(runner, context.id, holdingId, dto, true);
			const plans = planDescriptions(lines, { ...operation, contract_template: context.template, max_chars: context.max_chars });

			this.rejectExceeding(plans, dto.mode === 'set' ? 'text' : 'lines');
			const applied = plans.filter((plan) => !plan.skipped_reason);
			const bulkId = randomUUID();
			const eventIds: string[] = [];

			await this.writeLines(runner, holdingId, applied);
			for (const [invoiceId, invoicePlans] of this.byInvoice(applied)) {
				eventIds.push(
					await this.insertEvent(runner, context.id, holdingId, userId, {
						type: INVOICE_EVENT_TYPES.descriptions,
						title: `Descripciones de la factura actualizadas (${invoicePlans.length} ${invoicePlans.length === 1 ? 'línea' : 'líneas'})`,
						description: this.modeLabel(dto.mode),
						invoice_id: invoiceId,
						metadata: {
							mode: dto.mode,
							template: dto.mode === 'apply_blocks' ? operation.template : undefined,
							include_locked: dto.include_locked === true,
							bulk_id: bulkId,
							lines: invoicePlans.map((plan) => ({
								line_id: plan.line_id,
								before: plan.before,
								after: plan.after,
								locked_before: lines.find((line) => line.line_id === plan.line_id)?.locked ?? false,
								locked_after: plan.locked,
							})),
						},
					})
				);
			}

			const fitted = applied.filter((plan) => plan.fitted).map((plan) => ({ line_id: plan.line_id, steps: plan.fit_steps }));

			return {
				updated: applied.length,
				skipped: plans.filter((plan) => plan.skipped_reason).map((plan) => ({ line_id: plan.line_id, reason: plan.skipped_reason! })),
				event_ids: eventIds,
				fitted,
				warning_codes: fitted.length ? [DESCRIPTION_FITTED_CODE] : [],
			};
		});
	}

	private descriptionsPreview(plans: DescriptionLinePlan[], context: DescriptionContract) {
		return {
			lines: plans.map((plan) => ({
				line_id: plan.line_id,
				invoice_id: plan.invoice_id,
				before: plan.before,
				after: plan.after,
				length: plan.length,
				exceeds: plan.exceeds,
				locked: plan.locked,
				pending_fields: plan.pending_fields,
				fitted: plan.fitted,
				fit_steps: plan.fit_steps,
				...(plan.skipped_reason ? { skipped_reason: plan.skipped_reason } : {}),
			})),
			max_chars: context.max_chars,
			warning_codes: plans.some((plan) => plan.fitted && !plan.skipped_reason) ? [DESCRIPTION_FITTED_CODE] : [],
		};
	}

	private modeLabel(mode: UpdateInvoiceDescriptionsDto['mode']): string {
		switch (mode) {
			case 'set':
				return 'Texto escrito a mano (la línea queda protegida de regeneraciones)';
			case 'unlock':
				return 'Vuelve a la plantilla del contrato';
			case 'apply_blocks':
				return 'Regenerada con bloques elegidos para esta selección';
			default:
				return 'Regenerada con la plantilla del contrato';
		}
	}

	/**
	 * Modificaciones (`item_update`, corregir un dato del ítem, spec modificaciones §9.2): regenera con la plantilla del contrato la glosa de las líneas
	 * Por Emitir indicadas, dentro de la transacción del cambio (ya con `setApiWriter` y el contrato bloqueado). Mismas reglas que "aplicar
	 * plantilla": salta las protegidas (`description_locked`), las editadas a mano, la visible de una factura por OC y las facturas bloqueadas
	 * (no Por Emitir, unificadas, con borrador en el ERP). Devuelve las líneas escritas; el evento lo registra el cambio.
	 */
	async regenerateLines(runner: QueryRunner, contractId: string, holdingId: string, lineIds: string[]): Promise<DescriptionLinePlan[]> {
		const ids = [...new Set(lineIds)];

		if (!ids.length) return [];
		const context = await this.loadContract(runner, contractId, holdingId);
		const lines = await this.linesOf(runner, contractId, holdingId, `AND ii.id = ANY($3::uuid[])`, [ids]);

		if (!lines.length) return [];
		const invoices = await this.invoices.loadInvoicesByIds(
			runner,
			contractId,
			holdingId,
			[...new Set(lines.map((line) => line.invoice_id))],
			true
		);
		const plans = planDescriptions(this.withBlockers(lines, invoices), {
			mode: 'apply_template',
			contract_template: context.template,
			max_chars: context.max_chars,
		});
		const applied = plans.filter((plan) => !plan.skipped_reason);

		await this.writeLines(runner, holdingId, applied);

		return applied;
	}

	// ---------------------------------------------------------------- referencias OC/HES (§3.7a)

	/**
	 * Reemplaza las referencias propias de la factura (`invoice_references`; las del contrato vinculadas no se tocan) y, si viene,
	 * `invoices.requires_references_for_billing`. Por Emitir siempre (también la unificada v2, sin borrador en el ERP); emitidas solo si no
	 * se enviaron al ERP. Evento
	 * `INVOICE_REFERENCES_UPDATED` con antes/después. Devuelve las referencias como las lee el detalle.
	 */
	async updateReferences(idOrNumber: string, invoiceId: string, dto: UpdateInvoiceReferencesDto, holdingId: string, authId: string) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		const warnings = await this.transaction(contract.id, holdingId, async (runner) => {
			const invoice = await this.invoices.loadInvoice(runner, contract.id, invoiceId, holdingId, true);
			const existing = await this.loadReferences(runner, invoice.id, holdingId);
			// La unificada v2 Por Emitir admite sus referencias (Domi 07-10: hereda "Pide OC" y la OC se agrega antes de emitir).
			const unifiedV2 = await this.unifiedV2Ids(runner, holdingId, [invoice]);
			const plan = planReferences(invoice, dto.references, existing, { unified_v2: unifiedV2.has(invoice.id) });

			if (plan.duplicates.length) {
				throw validationException(
					plan.duplicates.map((index) => ({ field: `references.${index}.code`, message: 'Referencia repetida en la factura' }))
				);
			}
			if (!plan.can_apply) throw this.blocked(plan.blockers, { invoice_id: invoice.id, warnings: plan.warnings });
			const requiresBefore = invoice.requires_references;
			const requiresAfter = dto.requires_references_for_billing ?? requiresBefore;

			await runner.query(`DELETE FROM invoice_references WHERE invoice_id = $1 AND holding_id = $2`, [invoice.id, holdingId]);
			for (const row of plan.rows) {
				await runner.query(
					`INSERT INTO invoice_references (invoice_id, holding_id, document_number, document_type_code, document_type_name, reference_code, reason,
						reference_date, created_by)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9)`,
					[
						invoice.id,
						holdingId,
						row.document_number,
						row.document_type_code,
						row.document_type_name,
						row.reference_code,
						row.reason,
						row.reference_date,
						authId || null,
					]
				);
			}
			if (dto.requires_references_for_billing !== undefined && requiresAfter !== requiresBefore) {
				await runner.query(`UPDATE invoices SET requires_references_for_billing = $3 WHERE id = $1 AND holding_id = $2`, [
					invoice.id,
					holdingId,
					requiresAfter,
				]);
			}
			await this.insertEvent(runner, contract.id, holdingId, userId, {
				type: INVOICE_EVENT_TYPES.references,
				title: `Referencias de la factura ${invoice.invoice_number ?? ''} actualizadas`.replace(/\s+/g, ' ').trim(),
				description: plan.rows.length
					? plan.rows.map((row) => `${referenceKind(row.document_type_code, row.document_type_name)} ${row.document_number}`).join(', ')
					: 'Sin referencias propias',
				invoice_id: invoice.id,
				metadata: {
					invoice_number: invoice.invoice_number,
					before: { references: existing, requires_references_for_billing: requiresBefore },
					after: { references: plan.rows, requires_references_for_billing: requiresAfter },
					warnings: plan.warnings.map((warning) => warning.code),
				},
			});

			return plan.warnings;
		});
		const detail = await this.contracts.invoiceDetail(contract.id, invoiceId, holdingId);

		return {
			invoice_id: detail.id,
			requires_references_for_billing: detail.requires_references_for_billing,
			references: detail.references,
			warnings,
		};
	}

	private async loadReferences(db: Queryable, invoiceId: string, holdingId: string): Promise<InvoiceReferenceRow[]> {
		const rows = (await db.query(
			`SELECT r.document_type_code, r.document_type_name, r.document_number, r.reference_date::text AS reference_date, r.reference_code, r.reason
			FROM invoice_references r WHERE r.invoice_id = $1 AND r.holding_id = $2 ORDER BY r.created_at, r.id`,
			[invoiceId, holdingId]
		)) as Row[];

		return rows.map((row) => ({
			document_type_code: toText(row.document_type_code) ?? '',
			document_type_name: toText(row.document_type_name),
			document_number: toText(row.document_number) ?? '',
			reference_date: toText(row.reference_date),
			reference_code: toText(row.reference_code),
			reason: toText(row.reason),
		}));
	}

	// ---------------------------------------------------------------- validación

	private validTemplate(template: unknown): DescriptionTemplate {
		const errors = validateTemplate(template);

		if (errors.length) throw validationException(errors);

		return normalizeTemplate(template as DescriptionTemplate);
	}

	private validOperation(dto: UpdateInvoiceDescriptionsDto) {
		const errors: FieldError[] = [];

		if (!dto.invoice_ids?.length && !dto.line_ids?.length) {
			errors.push({ field: 'invoice_ids', message: 'Indica las facturas o las líneas' });
		}
		if (dto.mode === 'set' && !dto.text?.trim()) errors.push({ field: 'text', message: 'Escribe la descripción' });
		if (dto.mode === 'apply_blocks' && !dto.template) errors.push({ field: 'template', message: 'Indica la plantilla a aplicar' });
		if (errors.length) throw validationException(errors);

		return {
			mode: dto.mode,
			template: dto.mode === 'apply_blocks' ? this.validTemplate(dto.template) : null,
			text: dto.text ?? null,
			include_locked: dto.include_locked === true,
		};
	}

	/** 400 si alguna línea a escribir supera el límite del documento (`errors[{ field, message }]`, una por línea). */
	private rejectExceeding(plans: DescriptionLinePlan[], field: string) {
		const exceeding = plans.filter((plan) => !plan.skipped_reason && plan.exceeds);

		if (!exceeding.length) return;
		throw validationException(
			exceeding.map((plan) => ({
				field,
				message: `La línea ${plan.line_id} quedaría con ${plan.length} caracteres: supera el límite del documento`,
			}))
		);
	}

	// ---------------------------------------------------------------- carga

	private async loadContract(db: Queryable, contractId: string, holdingId: string): Promise<DescriptionContract> {
		const [row] = (await db.query(
			`SELECT c.id, c.invoice_description_template, c.tax_document_type_id, c.document_type,
				tdt.description_max_chars AS own_description_max_chars, co.country AS company_country, ${DESCRIPTION_LIMITS_SQL} AS description_limits
			FROM contracts c
			LEFT JOIN companies co ON co.id = c.company_id AND co.holding_id = c.holding_id
			LEFT JOIN tax_document_types tdt ON tdt.id = c.tax_document_type_id
			WHERE c.id = $1 AND c.holding_id = $2 AND c.deleted_at IS NULL`,
			[contractId, holdingId]
		)) as Row[];

		if (!row) throw new NotFoundException('Contrato no encontrado');

		return {
			id: String(row.id),
			template: parseStoredTemplate(row.invoice_description_template),
			max_chars: resolveDescriptionMaxChars({
				tax_document_type_id: toText(row.tax_document_type_id),
				own_max_chars: row.own_description_max_chars as number | null,
				company_country: toText(row.company_country),
				document_type: toText(row.document_type),
				limits: parseJson<DescriptionLimitRow[]>(row.description_limits),
			}),
		};
	}

	/** Primera línea de la próxima Por Emitir activa del contrato (la muestra del constructor), o null. */
	private async sampleLine(db: Queryable, contractId: string, holdingId: string): Promise<DescriptionLineRow | null> {
		const [next] = await this.invoices.loadPendingInvoices(db, contractId, holdingId);

		if (!next) return null;
		const [line] = await this.linesOf(db, contractId, holdingId, `AND i.id = $3::uuid`, [next.id]);

		return line ?? null;
	}

	/** Una línea de una factura del contrato (404 si no es del contrato o del holding). */
	private async lineById(db: Queryable, contractId: string, holdingId: string, lineId: string): Promise<DescriptionLineRow> {
		const [line] = await this.linesOf(db, contractId, holdingId, `AND ii.id = $3::uuid`, [lineId]);

		if (!line) throw new NotFoundException('Línea no encontrada en las facturas del contrato');

		return line;
	}

	/**
	 * Líneas elegidas (todas las de `invoice_ids` más las de `line_ids`), con el bloqueo de su factura: solo se tocan Por Emitir activas,
	 * no unificadas, no legacy, no NC/ND y que no estén ya en el ERP. Excepción: la unificada v2 Por Emitir (que vive en el 360 de su
	 * contrato principal) acepta el texto manual (`set`, Domi 07-10). 404 si una factura o línea no es del contrato.
	 */
	private async selectedLines(
		db: Queryable,
		contractId: string,
		holdingId: string,
		dto: Pick<UpdateInvoiceDescriptionsDto, 'invoice_ids' | 'line_ids' | 'mode'>,
		lock = false
	): Promise<DescriptionLineInput[]> {
		const lineIds = [...new Set(dto.line_ids ?? [])];
		const byLine = lineIds.length ? await this.linesOf(db, contractId, holdingId, `AND ii.id = ANY($3::uuid[])`, [lineIds]) : [];
		const missing = lineIds.filter((id) => !byLine.some((line) => line.line_id === id));

		if (missing.length) throw new NotFoundException(`Líneas que no son de facturas del contrato: ${missing.join(', ')}`);
		const invoiceIds = [...new Set([...(dto.invoice_ids ?? []), ...byLine.map((line) => line.invoice_id)])];
		const invoices = await this.invoices.loadInvoicesByIds(db, contractId, holdingId, invoiceIds, lock);
		const ofInvoices = dto.invoice_ids?.length
			? await this.linesOf(db, contractId, holdingId, `AND i.id = ANY($3::uuid[])`, [[...new Set(dto.invoice_ids)]])
			: [];

		const unifiedV2 = await this.unifiedV2Ids(db, holdingId, invoices);

		return this.withBlockers([...ofInvoices, ...byLine.filter((line) => !ofInvoices.some((own) => own.line_id === line.line_id))], invoices, {
			mode: dto.mode,
			unified_v2: unifiedV2,
		});
	}

	/** Unificadas v2 (con evento `INVOICE_CONSOLIDATED`) entre las facturas dadas. */
	private async unifiedV2Ids(db: Queryable, holdingId: string, invoices: ContractInvoiceRow[]): Promise<Set<string>> {
		const ids = invoices.filter((invoice) => invoice.invoice_type === 'Unificada').map((invoice) => invoice.id);

		if (!ids.length) return new Set();
		const rows = (await db.query(`SELECT i.id FROM invoices i WHERE i.holding_id = $1 AND i.id = ANY($2::uuid[]) AND ${unifiedV2Sql('i')}`, [
			holdingId,
			ids,
		])) as Row[];

		return new Set(rows.map((row) => String(row.id)));
	}

	/** Líneas de las Por Emitir activas del contrato (para `apply_to_pending`), con el bloqueo de su factura. */
	private async pendingLines(db: Queryable, contractId: string, holdingId: string, lock = false): Promise<DescriptionLineInput[]> {
		const invoices = await this.invoices.loadPendingInvoices(db, contractId, holdingId, lock);

		if (!invoices.length) return [];
		const lines = await this.linesOf(db, contractId, holdingId, `AND i.id = ANY($3::uuid[])`, [invoices.map((invoice) => invoice.id)]);

		return this.withBlockers(lines, invoices);
	}

	private withBlockers(
		lines: DescriptionLineRow[],
		invoices: ContractInvoiceRow[],
		options: { mode?: string | null; unified_v2?: Set<string> } = {}
	): DescriptionLineInput[] {
		const reasons = new Map(
			invoices.map((invoice) => {
				const blockers = descriptionBlockers(invoice, { mode: options.mode, unified_v2: options.unified_v2?.has(invoice.id) === true });

				return [invoice.id, blockers[0]?.code ?? null];
			})
		);

		return lines.map((line) => ({ ...line, blocked_reason: reasons.get(line.invoice_id) ?? null }));
	}

	private async linesOf(db: Queryable, contractId: string, holdingId: string, where: string, params: unknown[]): Promise<DescriptionLineRow[]> {
		const rows = (await db.query(`${LINES_SELECT} WHERE i.contract_id = $1 AND i.holding_id = $2 ${where} ${LINES_ORDER}`, [
			contractId,
			holdingId,
			...params,
		])) as Row[];

		return rows.map((row) => this.lineRow(row));
	}

	/** Contexto de render de una línea guardada: tipo de línea por su desglose (fila por tramo) y el modelo de precio del ítem. */
	private lineRow(row: Row): DescriptionLineRow {
		const breakdown = parseJson<Array<Record<string, unknown>>>(row.pricing_breakdown);
		const model = toText(row.price_model);
		const priced = model !== null && !(model === 'standard' && toText(row.price_quantity_type) === 'fixed');
		const perTier = isPerTierBreakdown(breakdown);
		const source = toText(row.quantity_source);
		const references = (parseJson<Array<Record<string, unknown>>>(row.references) ?? [])
			.map((ref): DescriptionReference => ({ kind: referenceKind(toText(ref.type), toText(ref.name)), code: toText(ref.code) ?? '' }))
			.filter((ref) => ref.code.trim());

		return {
			line_id: String(row.id),
			invoice_id: String(row.invoice_id),
			description: toText(row.description),
			locked: row.description_locked === true,
			manual: source === 'manual',
			po_visible: row.po_visible === true,
			context: {
				line_kind: perTier ? 'per_tier' : priced ? 'single' : 'standard',
				product_name: toText(row.product_name)?.trim() || 'Producto',
				account: toText(row.account),
				period_start: toText(row.billing_period_start),
				period_end: toText(row.billing_period_end),
				tier_label: perTier ? tierLabelFromBreakdown(breakdown) : null,
				breakdown: perTier || !Array.isArray(breakdown) ? null : (breakdown as DescriptionContext['breakdown']),
				quantity: toNullableNumber(row.quantity),
				unit: toText(row.unit_of_measure),
				quantity_final: source !== 'pending' && source !== 'estimated',
				unit_price: toNullableNumber(row.unit_price_contract_currency),
				amount: toNullableNumber(row.subtotal_contract_currency),
				contract_currency: toText(row.contract_currency),
				invoice_currency: toText(row.invoice_currency),
				fx_rate: toNullableNumber(row.fx_contract_to_invoice),
				contract_number: toText(row.contract_number),
				references,
				client_name: toText(row.legal_name),
			},
		};
	}

	private render(template: DescriptionTemplate | null, line: DescriptionLineRow, maxChars: number | null) {
		const rendered = fitDescription(template, line.context, maxChars);

		return {
			line_id: line.line_id,
			invoice_id: line.invoice_id,
			text: rendered.text,
			length: rendered.length,
			exceeds: exceedsMax(rendered.length, maxChars),
			pending_fields: rendered.pending_fields,
			fitted: rendered.fitted,
			steps: rendered.steps,
		};
	}

	private byInvoice(plans: DescriptionLinePlan[]): Map<string, DescriptionLinePlan[]> {
		const groups = new Map<string, DescriptionLinePlan[]>();

		for (const plan of plans) groups.set(plan.invoice_id, [...(groups.get(plan.invoice_id) ?? []), plan]);

		return groups;
	}

	// ---------------------------------------------------------------- escritura

	/** Glosa y protección de cada línea; solo en Por Emitir (la condición se repite en el UPDATE). */
	private async writeLines(runner: QueryRunner, holdingId: string, plans: DescriptionLinePlan[]) {
		for (const plan of plans) {
			await runner.query(
				`UPDATE invoice_items ii SET description = $3, description_locked = $4, updated_at = now()
				FROM invoices i
				WHERE ii.id = $1 AND ii.holding_id = $2 AND i.id = ii.invoice_id AND i.status = '${PENDING_STATUS}' AND i.is_active = true`,
				[plan.line_id, holdingId, plan.after, plan.locked]
			);
		}
	}

	/** Una transacción con la costura `sapira.writer = 'api'` y el contrato bloqueado (`FOR UPDATE`). */
	private async transaction<T>(contractId: string, holdingId: string, work: (runner: QueryRunner) => Promise<T>): Promise<T> {
		const runner = this.dataSource.createQueryRunner();
		let active = false;

		await runner.connect();
		await runner.startTransaction();
		active = true;
		try {
			await setApiWriter(runner);
			await runner.query(`SELECT id FROM contracts WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL FOR UPDATE`, [
				contractId,
				holdingId,
			]);
			const result = await work(runner);

			await runner.commitTransaction();
			active = false;

			return result;
		} catch (error) {
			if (active) await runner.rollbackTransaction();
			if (!(error instanceof HttpException)) {
				this.logger.warn(
					`Descripciones/referencias del contrato ${contractId} no aplicadas: ${error instanceof Error ? error.message : String(error)}`
				);
			}
			throw error;
		} finally {
			await runner.release();
		}
	}

	private blocked(blockers: InvoiceBlocker[], preview: unknown): ConflictException {
		return new ConflictException({
			message: `No se puede aplicar: ${blockers.map((blocker) => blocker.message).join('; ')}`,
			code: 'blocked',
			blockers,
			preview,
		});
	}

	private async insertEvent(runner: QueryRunner, contractId: string, holdingId: string, userId: string, event: DescriptionEvent): Promise<string> {
		const [row] = (await runner.query(
			`INSERT INTO contract_lifecycle_events (
				contract_id, holding_id, event_type, event_status, title, description, summary, created_by, completed_at, effective_date, metadata
			) VALUES ($1, $2, $3, 'Completed', $4, $5, $5, $6, now(), CURRENT_DATE, $7::jsonb) RETURNING id`,
			[
				contractId,
				holdingId,
				event.type,
				event.title,
				event.description,
				userId,
				JSON.stringify({ source: 'contract_360', ...(event.invoice_id ? { invoice_id: event.invoice_id } : {}), ...event.metadata }),
			]
		)) as Row[];

		return String(row.id);
	}
}
