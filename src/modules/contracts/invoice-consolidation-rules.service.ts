import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { holdingTimezone } from '@/core/utils/holding-preferences';

import { withApiWriter } from './api-writer';
import { todayFor } from './business-date';
import { PENDING_STATUS } from './contract-360';
import { resolveUserId } from './contract-drafts.service';
import { ContractInvoiceConsolidationService } from './contract-invoice-consolidation.service';
import { type InvoiceBlocker } from './contract-invoices';
import { type JobHoldingResult } from './contract-renewals.service';
import { CONSOLIDATION_EVENT_TYPES, UNIFIED_INVOICE_TYPES } from './invoice-consolidation-read';
import {
	CONSOLIDATION_RULE_JOB_SOURCE,
	CONSOLIDATION_RULE_PAUSE_REASON,
	CONSOLIDATION_RULE_SOURCE,
	CONSOLIDATION_RULE_UNDO_REASON,
	issueDayOf,
	planRuleGroups,
	type RuleGroup,
	type RuleInvoice,
	type RuleUnified,
	validateRuleInput,
} from './invoice-consolidation-rules';

import type {
	InvoiceConsolidationRuleDto,
	InvoiceConsolidationRulePauseDto,
	InvoiceConsolidationRulePreviewDto,
} from './dtos/invoice-consolidation-rule.dto';

type Row = Record<string, unknown>;

const text = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));
const numberOrNull = (value: unknown) => (value === null || value === undefined || value === '' ? null : Number(value));
const day = (value: unknown) => (value ? String(value).slice(0, 10) : null);

/** Contrato activo de la razón social (lo que muestra la tarjeta y valida guardar). */
export interface RuleContract {
	id: string;
	contract_number: string | null;
	client_id: string | null;
	client_name: string | null;
	company_id: string | null;
	company_name: string | null;
	invoice_currency: string | null;
	document_type: string | null;
	in_rule: boolean;
	issue_day: number | null;
}

interface RuleRow {
	id: string;
	holding_id: string;
	client_entity_id: string;
	main_contract_id: string;
	contract_ids: string[];
	status: 'active' | 'paused';
	created_by: string | null;
	updated_by: string | null;
	created_by_name: string | null;
	created_at: string;
	updated_at: string;
}

const RULE_SQL = `SELECT r.id, r.holding_id, r.client_entity_id, r.main_contract_id, r.contract_ids::text[] AS contract_ids, r.status,
	r.created_by, r.updated_by, COALESCE(u.name, u.email) AS created_by_name, r.created_at, r.updated_at
	FROM invoice_consolidation_rules r LEFT JOIN users u ON u.id = r.created_by`;

/** Contratos activos de la razón social (receptora de sus facturas). */
const CONTRACTS_SQL = `SELECT c.id, c.contract_number, c.client_id, cl.name_commercial AS client_name, c.company_id, co.legal_name AS company_name,
	UPPER(COALESCE(NULLIF(c.invoice_currency, ''), c.contract_currency)) AS invoice_currency, COALESCE(c.document_type, 'FACTURA') AS document_type,
	(SELECT array_agg(COALESCE(i.issue_date, i.scheduled_at)::text ORDER BY COALESCE(i.issue_date, i.scheduled_at)) FROM invoices i
		WHERE i.contract_id = c.id AND i.holding_id = c.holding_id AND i.status = '${PENDING_STATUS}' AND COALESCE(i.document_type, 'FACTURA') NOT IN ('NC', 'ND')
		AND (i.is_active = true OR i.consolidated_into_invoice_id IS NOT NULL)) AS pending_dates
	FROM contracts c
	LEFT JOIN clients cl ON cl.id = c.client_id
	LEFT JOIN companies co ON co.id = c.company_id
	WHERE c.holding_id = $1 AND c.client_entity_id = $2 AND c.deleted_at IS NULL AND c.status = 'Activo'
	ORDER BY c.contract_number, c.id`;

/**
 * Por Emitir de los contratos: sueltas (activas) y orígenes de una unificada (inactivas con `consolidated_into_invoice_id`). Sin NC/ND,
 * sin legacy y sin documentos unificados (esos son el resultado, no el origen).
 */
const INVOICES_SQL = `SELECT i.id, i.contract_id, c.contract_number, i.company_id, UPPER(i.invoice_currency) AS invoice_currency,
	COALESCE(i.document_type, 'FACTURA') AS document_type, COALESCE(i.export_type, 0) AS export_type, i.invoice_series,
	to_char(COALESCE(i.issue_date, i.scheduled_at), 'YYYY-MM') AS month, COALESCE(i.issue_date, i.scheduled_at)::text AS issue_date,
	COALESCE(i.total_invoice_currency, i.amount_invoice_currency, i.amount_contract_currency) AS total, i.consolidated_into_invoice_id
	FROM invoices i JOIN contracts c ON c.id = i.contract_id
	WHERE i.holding_id = $1 AND i.contract_id = ANY($2::uuid[]) AND i.status = '${PENDING_STATUS}'
		AND (i.is_active = true OR i.consolidated_into_invoice_id IS NOT NULL)
		AND COALESCE(i.document_type, 'FACTURA') NOT IN ('NC', 'ND') AND COALESCE(i.is_legacy, false) = false
		AND COALESCE(i.invoice_type, '') NOT IN (${UNIFIED_INVOICE_TYPES.map((type) => `'${type}'`).join(', ')})
		AND COALESCE(i.issue_date, i.scheduled_at) IS NOT NULL
	ORDER BY COALESCE(i.issue_date, i.scheduled_at), c.contract_number, i.id`;

const UNIFIED_SQL = `SELECT u.id, u.invoice_number, u.status, COALESCE(u.issue_date, u.scheduled_at)::text AS issue_date,
	COALESCE(u.total_invoice_currency, u.amount_invoice_currency) AS total, UPPER(u.invoice_currency) AS currency,
	(u.odoo_invoice_id IS NOT NULL OR u.sent_to_odoo_at IS NOT NULL) AS sent_to_erp
	FROM invoices u WHERE u.holding_id = $1 AND u.id = ANY($2::uuid[]) AND u.is_active = true`;

/**
 * Unificación recurrente de facturas de una razón social (`docs/v2-rediseno/spec-unificacion-recurrente.md`, decisiones de Domi 05-10):
 * la regla (`invoice_consolidation_rules`) dice qué contratos se facturan en un solo documento cada mes y cuál es el principal (encabezado
 * y fecha de emisión). Guardarla unifica ya todas las Por Emitir de esos contratos, también de meses pasados; el job diario
 * (`ContractsScheduler`, 06:30) une las que nacen después. Reutiliza la consolidación (`ContractInvoiceConsolidationService`): mismas
 * condiciones, mismo documento, deshacer y re-copia por consumo. El estado por mes se deriva de las facturas; no se guarda.
 */
@Injectable()
export class InvoiceConsolidationRulesService {
	private readonly logger = new Logger(InvoiceConsolidationRulesService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly consolidation: ContractInvoiceConsolidationService
	) {}

	// ---------------------------------------------------------------- lectura

	/** `GET client-entities/:id/invoice-consolidation`: la regla, los contratos activos, los nuevos fuera de la regla y el estado por mes. */
	async view(entityId: string, holdingId: string, at = new Date()) {
		await this.assertEntity(entityId, holdingId);
		const today = todayFor(await holdingTimezone(this.dataSource, holdingId), at);
		const rule = await this.loadRule(holdingId, entityId);
		const contracts = await this.loadContracts(holdingId, entityId, today, rule?.contract_ids ?? []);
		const groups = rule ? await this.groupsFor(holdingId, rule.contract_ids) : [];
		const months = await Promise.all(groups.map((group) => this.monthView(holdingId, group, rule?.main_contract_id ?? null, 'state')));

		return {
			rule: rule ? this.ruleView(rule) : null,
			contracts,
			new_contract_ids: rule ? contracts.filter((contract) => !contract.in_rule).map((contract) => contract.id) : [],
			months,
			summary: {
				unified: months.filter((month) => month.state === 'unified').length,
				pending: months.filter((month) => month.state === 'pending').length,
				blocked: months.filter((month) => month.state === 'blocked').length,
				single: months.filter((month) => month.state === 'single').length,
			},
		};
	}

	/** `POST …/preview`: qué pasaría con estos contratos y este principal, mes a mes. No escribe. */
	async preview(entityId: string, dto: InvoiceConsolidationRulePreviewDto, holdingId: string, at = new Date()) {
		await this.assertEntity(entityId, holdingId);
		const today = todayFor(await holdingTimezone(this.dataSource, holdingId), at);
		const contracts = await this.loadContracts(holdingId, entityId, today, dto.contract_ids);
		const contractIds = this.validate(dto, contracts);
		const groups = await this.groupsFor(holdingId, contractIds);
		const months = await Promise.all(groups.map((group) => this.monthView(holdingId, group, dto.main_contract_id, 'preview')));
		const main = contracts.find((contract) => contract.id === dto.main_contract_id)!;

		return {
			main_contract: { id: main.id, contract_number: main.contract_number, issue_day: main.issue_day },
			months,
			summary: {
				will_unify: months.filter((month) => month.state === 'will_unify').length,
				already_unified: months.filter((month) => month.state === 'already_unified').length,
				blocked: months.filter((month) => month.state === 'blocked').length,
				single: months.filter((month) => month.state === 'single').length,
			},
		};
	}

	// ---------------------------------------------------------------- escritura

	/** `PUT`: guarda la regla (activa) y unifica ya. 400 sin confirmar la fecha de emisión o con contratos inválidos. */
	async save(entityId: string, dto: InvoiceConsolidationRuleDto, holdingId: string, authId: string, at = new Date()) {
		if (dto.confirm_issue_date !== true)
			throw new BadRequestException({
				message: 'Confirma la fecha de emisión de la factura unificada',
				errors: [{ field: 'confirm_issue_date', message: 'Confirma que la unificada se emite en la fecha del contrato principal' }],
			});
		await this.assertEntity(entityId, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);
		const today = todayFor(await holdingTimezone(this.dataSource, holdingId), at);
		const contracts = await this.loadContracts(holdingId, entityId, today, dto.contract_ids);
		const contractIds = this.validate(dto, contracts);

		await withApiWriter(this.dataSource, (runner) =>
			runner.query(
				`INSERT INTO invoice_consolidation_rules (holding_id, client_entity_id, main_contract_id, contract_ids, status, created_by, updated_by)
			VALUES ($1, $2, $3, $4::uuid[], 'active', $5, $5)
			ON CONFLICT (holding_id, client_entity_id) DO UPDATE SET main_contract_id = EXCLUDED.main_contract_id,
				contract_ids = EXCLUDED.contract_ids, status = 'active', updated_by = EXCLUDED.updated_by, updated_at = now()`,
				[holdingId, entityId, dto.main_contract_id, contractIds, userId]
			)
		);
		const rule = (await this.loadRule(holdingId, entityId))!;
		const result = await this.runRule(rule, userId, CONSOLIDATION_RULE_SOURCE, at);

		return { ...(await this.view(entityId, holdingId, at)), result };
	}

	/** `POST …/pause`: la regla queda pausada; con `undo_pending`, deshace las unificadas de la regla que siguen Por Emitir sin ERP. */
	async pause(entityId: string, dto: InvoiceConsolidationRulePauseDto, holdingId: string, authId: string, at = new Date()) {
		const rule = await this.requireRule(holdingId, entityId);
		const userId = await resolveUserId(this.dataSource, authId);

		await withApiWriter(this.dataSource, (runner) =>
			runner.query(
				`UPDATE invoice_consolidation_rules SET status = 'paused', updated_by = $3, updated_at = now() WHERE id = $1 AND holding_id = $2`,
				[rule.id, holdingId, userId]
			)
		);
		let undone = 0;
		let kept = 0;

		if (dto.undo_pending) {
			const rows = (await this.dataSource.query(
				`SELECT DISTINCT u.id FROM contract_lifecycle_events e JOIN invoices u ON u.id = (e.metadata->>'consolidated_invoice_id')::uuid
				WHERE e.holding_id = $1 AND e.event_type = '${CONSOLIDATION_EVENT_TYPES.consolidated}' AND e.metadata->>'rule_id' = $2::text
					AND u.holding_id = $1 AND u.is_active = true AND u.status = '${PENDING_STATUS}'`,
				[holdingId, rule.id]
			)) as Row[];

			for (const row of rows) {
				try {
					await this.consolidation.undoInvoice(
						String(row.id),
						CONSOLIDATION_RULE_PAUSE_REASON,
						holdingId,
						userId,
						at,
						CONSOLIDATION_RULE_SOURCE
					);
					undone += 1;
				} catch (error) {
					if (!(error instanceof ConflictException)) throw error;
					kept += 1;
				}
			}
		}

		return { ...(await this.view(entityId, holdingId, at)), result: { undone, kept } };
	}

	/** `POST …/resume`: la regla vuelve a `active` y unifica lo pendiente. */
	async resume(entityId: string, holdingId: string, authId: string, at = new Date()) {
		const rule = await this.requireRule(holdingId, entityId);
		const userId = await resolveUserId(this.dataSource, authId);

		await withApiWriter(this.dataSource, (runner) =>
			runner.query(
				`UPDATE invoice_consolidation_rules SET status = 'active', updated_by = $3, updated_at = now() WHERE id = $1 AND holding_id = $2`,
				[rule.id, holdingId, userId]
			)
		);
		const result = await this.runRule({ ...rule, status: 'active' }, userId, CONSOLIDATION_RULE_SOURCE, at);

		return { ...(await this.view(entityId, holdingId, at)), result };
	}

	// ---------------------------------------------------------------- job diario

	/** Job diario: por holding, cada regla activa unifica lo que falta (nuevas Por Emitir, o re-unifica si apareció una en un mes ya unido). */
	async runAll(at = new Date()): Promise<JobHoldingResult[]> {
		const holdings = (await this.dataSource.query(
			`SELECT DISTINCT holding_id FROM invoice_consolidation_rules WHERE status = 'active'`
		)) as Row[];
		const results: JobHoldingResult[] = [];

		for (const { holding_id } of holdings) {
			const holdingId = String(holding_id);

			try {
				const rules = (await this.dataSource.query(`${RULE_SQL} WHERE r.holding_id = $1 AND r.status = 'active'`, [holdingId])) as Row[];
				let events = 0;

				for (const row of rules) {
					const rule = this.ruleOf(row);
					// El job actúa a nombre de quien dejó la regla (el historial del contrato exige autor).
					const userId = rule.updated_by ?? rule.created_by;

					if (!userId) continue;
					const result = await this.runRule(rule, userId, CONSOLIDATION_RULE_JOB_SOURCE, at);

					events += result.unified;
				}
				results.push({ holding_id: holdingId, success: true, events });
			} catch (error) {
				this.logger.error(`Unificación recurrente, holding ${holdingId}: ${error instanceof Error ? error.message : String(error)}`);
				results.push({ holding_id: holdingId, success: false, events: 0, error: error instanceof Error ? error.message : String(error) });
			}
		}

		return results;
	}

	/**
	 * Aplica una regla: por cada grupo (mes y documento) une las sueltas, o deshace y vuelve a armar la unificada si apareció una factura
	 * nueva del mes. Cada grupo en su propia transacción (la de la consolidación): uno bloqueado no frena al resto.
	 */
	private async runRule(rule: RuleRow, userId: string, source: string, at: Date): Promise<{ unified: number; blocked: number }> {
		const groups = await this.groupsFor(rule.holding_id, rule.contract_ids);
		let unified = 0;
		let blocked = 0;
		const options = { main_contract_id: rule.main_contract_id, rule_id: rule.id, source };

		for (const group of groups) {
			if (group.action !== 'unify' && group.action !== 'reunify') {
				if (group.action === 'blocked') blocked += 1;
				continue;
			}
			try {
				if (group.action === 'reunify' && group.unified)
					await this.consolidation.undoInvoice(group.unified.id, CONSOLIDATION_RULE_UNDO_REASON, rule.holding_id, userId, at, source);
				await this.consolidation.applyInvoices(group.to_consolidate, rule.holding_id, userId, options, at);
				unified += 1;
			} catch (error) {
				if (!(error instanceof ConflictException)) throw error;
				blocked += 1;
			}
		}

		return { unified, blocked };
	}

	// ---------------------------------------------------------------- piezas

	private async groupsFor(holdingId: string, contractIds: string[]): Promise<RuleGroup[]> {
		const rows = (await this.dataSource.query(INVOICES_SQL, [holdingId, contractIds])) as Row[];
		const invoices: RuleInvoice[] = rows.map((row) => ({
			id: String(row.id),
			contract_id: String(row.contract_id),
			contract_number: text(row.contract_number),
			company_id: text(row.company_id),
			invoice_currency: text(row.invoice_currency),
			document_type: text(row.document_type),
			export_type: Number(row.export_type ?? 0),
			invoice_series: text(row.invoice_series),
			month: String(row.month),
			issue_date: day(row.issue_date),
			total: numberOrNull(row.total),
			consolidated_into_invoice_id: text(row.consolidated_into_invoice_id),
		}));
		const unifiedIds = [...new Set(invoices.map((invoice) => invoice.consolidated_into_invoice_id).filter((id): id is string => !!id))];
		const unifiedRows = unifiedIds.length ? ((await this.dataSource.query(UNIFIED_SQL, [holdingId, unifiedIds])) as Row[]) : [];
		const unifiedById = new Map<string, RuleUnified>(
			unifiedRows.map((row) => [
				String(row.id),
				{
					id: String(row.id),
					invoice_number: text(row.invoice_number),
					status: text(row.status),
					issue_date: day(row.issue_date),
					total: numberOrNull(row.total),
					currency: text(row.currency),
					sent_to_erp: row.sent_to_erp === true,
				},
			])
		);
		// Un origen cuya unificada ya no está vigente (cancelada) cuenta como suelto.
		const live = invoices.map((invoice) =>
			invoice.consolidated_into_invoice_id && !unifiedById.has(invoice.consolidated_into_invoice_id)
				? { ...invoice, consolidated_into_invoice_id: null }
				: invoice
		);

		return planRuleGroups(live, unifiedById);
	}

	/**
	 * Un mes para la tarjeta (`state`: unified · pending · blocked · single) o para la vista previa (`will_unify` · `already_unified` ·
	 * `blocked` · `single`). Los grupos por unir pasan por `planConsolidation` (con el principal fijado) para mostrar sus bloqueos y la fecha
	 * de emisión que tendría la unificada.
	 */
	private async monthView(holdingId: string, group: RuleGroup, mainContractId: string | null, mode: 'state' | 'preview') {
		let blockers: InvoiceBlocker[] = group.blockers;
		let warnings: Array<{ code: string; message: string }> = [];
		let issueDate: string | null = group.unified?.issue_date ?? null;

		if (group.action === 'unify' || group.action === 'reunify') {
			const plan = await this.consolidation.preview({ invoice_ids: group.to_consolidate }, holdingId, mainContractId);

			blockers = plan.blockers;
			warnings = plan.warnings.map((warning) => ({ code: warning.code, message: warning.message }));
			issueDate = plan.header.issue_date;
		}
		const visible = [...group.origins, ...group.loose];
		const totals = new Map<string, number>();

		for (const invoice of visible) {
			const currency = invoice.invoice_currency ?? '';

			totals.set(currency, Math.round(((totals.get(currency) ?? 0) + (invoice.total ?? 0)) * 100) / 100);
		}
		const blocked = blockers.length > 0;
		const state =
			mode === 'state'
				? group.action === 'unified'
					? 'unified'
					: group.action === 'single'
						? 'single'
						: blocked
							? 'blocked'
							: 'pending'
				: group.action === 'unified'
					? 'already_unified'
					: group.action === 'single'
						? 'single'
						: blocked
							? 'blocked'
							: 'will_unify';

		return {
			month: group.month,
			state,
			issue_date: issueDate,
			unified_invoice: group.unified
				? {
						id: group.unified.id,
						invoice_number: group.unified.invoice_number,
						status: group.unified.status,
						issue_date: group.unified.issue_date,
						total: group.unified.total,
						currency: group.unified.currency,
					}
				: null,
			invoices: visible.map((invoice) => ({
				id: invoice.id,
				contract_id: invoice.contract_id,
				contract_number: invoice.contract_number,
				issue_date: invoice.issue_date,
				total: invoice.total,
				currency: invoice.invoice_currency,
			})),
			totals: [...totals.entries()].map(([currency, total]) => ({ currency, total })),
			blockers: blockers.map((blocker) => ({ code: blocker.code, message: blocker.message })),
			warnings,
		};
	}

	private validate(dto: { contract_ids: string[]; main_contract_id: string }, contracts: RuleContract[]): string[] {
		const errors = validateRuleInput(dto, new Set(contracts.map((contract) => contract.id)));

		if (errors.length) throw new BadRequestException({ message: errors[0].message, errors });

		return [...new Set(dto.contract_ids)];
	}

	private async loadContracts(holdingId: string, entityId: string, today: string, ruleContractIds: string[]): Promise<RuleContract[]> {
		const rows = (await this.dataSource.query(CONTRACTS_SQL, [holdingId, entityId])) as Row[];
		const inRule = new Set(ruleContractIds);

		return rows.map((row) => ({
			id: String(row.id),
			contract_number: text(row.contract_number),
			client_id: text(row.client_id),
			client_name: text(row.client_name),
			company_id: text(row.company_id),
			company_name: text(row.company_name),
			invoice_currency: text(row.invoice_currency),
			document_type: text(row.document_type),
			in_rule: inRule.has(String(row.id)),
			issue_day: issueDayOf(Array.isArray(row.pending_dates) ? row.pending_dates.map((value) => String(value).slice(0, 10)) : [], today),
		}));
	}

	private async loadRule(holdingId: string, entityId: string): Promise<RuleRow | null> {
		const [row] = (await this.dataSource.query(`${RULE_SQL} WHERE r.holding_id = $1 AND r.client_entity_id = $2`, [
			holdingId,
			entityId,
		])) as Row[];

		return row ? this.ruleOf(row) : null;
	}

	private async requireRule(holdingId: string, entityId: string): Promise<RuleRow> {
		await this.assertEntity(entityId, holdingId);
		const rule = await this.loadRule(holdingId, entityId);

		if (!rule) throw new NotFoundException('Esta razón social no tiene una unificación de facturas');

		return rule;
	}

	private async assertEntity(entityId: string, holdingId: string): Promise<void> {
		const [row] = (await this.dataSource.query(`SELECT 1 FROM client_entities WHERE id = $1 AND holding_id = $2`, [
			entityId,
			holdingId,
		])) as Row[];

		if (!row) throw new NotFoundException('Razón social no encontrada');
	}

	private ruleOf(row: Row): RuleRow {
		return {
			id: String(row.id),
			holding_id: String(row.holding_id),
			client_entity_id: String(row.client_entity_id),
			main_contract_id: String(row.main_contract_id),
			contract_ids: Array.isArray(row.contract_ids) ? row.contract_ids.map(String) : [],
			status: row.status === 'paused' ? 'paused' : 'active',
			created_by: text(row.created_by),
			updated_by: text(row.updated_by),
			created_by_name: text(row.created_by_name),
			created_at: String(row.created_at),
			updated_at: String(row.updated_at),
		};
	}

	private ruleView(rule: RuleRow) {
		return {
			id: rule.id,
			status: rule.status,
			main_contract_id: rule.main_contract_id,
			contract_ids: rule.contract_ids,
			created_at: rule.created_at,
			updated_at: rule.updated_at,
			created_by: rule.created_by ? { id: rule.created_by, name: rule.created_by_name } : null,
		};
	}
}
