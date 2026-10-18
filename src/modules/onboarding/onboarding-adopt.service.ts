import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { withApiWriter } from '@/modules/contracts/api-writer';
import { refreshInvoiceSystemAmounts } from '@/modules/contracts/api-written-fields';
import type { Month } from '@/modules/metrics/metrics-period';

import {
	ADOPT_FX_RATE_SOURCE,
	ADOPT_REMAINDER_SPLIT_REASON,
	adoptedStatus,
	type AdoptSourceLine,
	allocateCoverage,
	type ScaledLine,
	scaleLines,
	splitExact,
} from './onboarding-adopt';
import {
	conflict,
	firstDay,
	insertOnboardingEvent,
	isoDate,
	monthOf,
	nextMonthStart,
	num,
	numOrNull,
	type OnboardingActor,
	type Queryable,
	round2,
	round6,
	type Row,
	str,
} from './onboarding-common';

import type { AdoptPreviousInvoiceItemDto, AdoptPreviousInvoicesDto, AdoptPreviousInvoicesPreviewDto } from './dtos/onboarding-adopt.dto';

/** Evento del 360 del contrato (`contract_lifecycle_events.event_type`). */
export const ADOPTED_EVENT_TYPE = 'INVOICE_ADOPTED_FROM_PREVIOUS';
/** Diferencia de neto (en moneda de contrato) a partir de la cual se avisa que la cobertura no calza con la Por Emitir. */
const AMOUNT_WARNING_PCT = 0.1;
const CENT = 0.01;

export interface AdoptIssue {
	code: string;
	message: string;
}

export interface AdoptContractCandidate {
	id: string;
	contract_number: string | null;
	status: string | null;
	contract_currency: string | null;
	client_entity_id: string | null;
	company_id: string | null;
	first_month: Month | null;
	last_month: Month | null;
	/** Meses con una Por Emitir adoptable (sin borrador en el ERP). */
	pending_months: Month[];
}

export interface AdoptTarget {
	month: Month;
	kind: 'replace' | 'create';
	/** `replace`: la Por Emitir que se reescribe; `create`: la factura del contrato que sirve de plantilla para las líneas. */
	invoice_id: string;
	/** Neto actual del destino en moneda de contrato (Por Emitir o plantilla). */
	target_amount_contract_currency: number;
	/** Parte del neto de la previa que cubre este mes (moneda de contrato). */
	coverage_contract_currency: number;
	/** `keep_remainder` y cobertura menor que la Por Emitir: lo que queda como Por Emitir nueva. */
	remainder_contract_currency: number | null;
	template_invoice_number: string | null;
}

export interface AdoptPreviewItem {
	invoice: {
		id: string;
		invoice_number: string | null;
		issue_date: string | null;
		status: string | null;
		invoice_currency: string | null;
		amount_invoice_currency: number;
		vat: number;
		total_invoice_currency: number;
		entity_legal_name: string | null;
		client_name: string | null;
		company_legal_name: string | null;
		erp_invoice_id: number | null;
		has_history: boolean;
	};
	months: Month[];
	keep_remainder: boolean;
	targets: AdoptTarget[];
	amounts: {
		contract_currency: string;
		invoice_currency: string;
		fx_contract_to_invoice: number;
		amount_contract_currency: number;
		vat_contract_currency: number;
		status: string;
	} | null;
	history_months: Month[];
	blockers: AdoptIssue[];
	warnings: AdoptIssue[];
	can_apply: boolean;
}

export interface AdoptPreview {
	client: { id: string; name: string | null } | null;
	contracts: AdoptContractCandidate[];
	contract: AdoptContractCandidate | null;
	invoices: AdoptPreviewItem[];
	can_apply: boolean;
}

interface LegacyRow {
	id: string;
	invoice_number: string | null;
	issue_date: string | null;
	due_date: string | null;
	status: string | null;
	invoice_currency: string | null;
	amount_invoice_currency: number;
	vat: number | null;
	total_invoice_currency: number | null;
	fx_contract_to_invoice: number | null;
	client_id: string | null;
	client_name: string | null;
	client_entity_id: string | null;
	entity_legal_name: string | null;
	company_id: string | null;
	company_legal_name: string | null;
	erp_invoice_id: number | null;
	source_system: string | null;
	pdf_url: string | null;
	reconciliation_status: string | null;
	reconciled_invoice_id: string | null;
	has_history: boolean;
}

interface ContractInvoiceRow {
	id: string;
	invoice_number: string | null;
	status: string;
	issue_date: string | null;
	odoo_invoice_id: number | null;
	amount_contract_currency: number;
	vat: number | null;
	contract_currency: string | null;
	invoice_currency: string | null;
	fx_contract_to_invoice: number | null;
}

type Amounts = NonNullable<AdoptPreviewItem['amounts']>;

/**
 * Adoptar como factura del contrato (§4.5): una factura previa ya emitida en el ERP pasa a ser la factura de uno o varios meses del
 * contrato, con su número, fechas, moneda, montos, estado e id del ERP. Por cada mes: reemplaza la Por Emitir si existe (con remanente
 * opcional si la previa cubre solo parte) o se crea con las líneas de la factura más cercana del contrato como plantilla. La previa queda
 * `migrated` y sus meses salen del histórico. Es "reconciliar legacy con Por Emitir" del front anterior
 * (`reconcile_legacy_with_por_emitir`), sin `contract_invoices` (la API v2 no la usa).
 *
 * El ERP actualiza pagos buscando la factura por el id de Sapira, no por el id del ERP: una factura adoptada conserva el estado con que
 * se adoptó (Pagada/Vencida/Enviada/Emitida) y no se reenvía (`sent_to_odoo_at` queda marcado).
 */
@Injectable()
export class OnboardingAdoptService {
	constructor(private readonly dataSource: DataSource) {}

	async preview(holdingId: string, dto: AdoptPreviousInvoicesPreviewDto): Promise<AdoptPreview> {
		return this.buildPreview(this.dataSource, holdingId, dto.invoices, dto.contract_id ?? null);
	}

	async apply(holdingId: string, dto: AdoptPreviousInvoicesDto, actor: OnboardingActor) {
		return withApiWriter(this.dataSource, async (runner) => {
			const [locked] = (await runner.query(`SELECT id FROM contracts WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL FOR UPDATE`, [
				dto.contract_id,
				holdingId,
			])) as Row[];

			if (!locked) throw new NotFoundException('Contrato no encontrado');
			const preview = await this.buildPreview(runner, holdingId, dto.invoices, dto.contract_id);

			if (!preview.can_apply || !preview.contract) {
				throw conflict('adopt_blocked', 'Hay facturas que no se pueden adoptar: revisa los bloqueos', { preview });
			}
			const adopted: Array<{
				previous_invoice_id: string;
				invoice_number: string | null;
				invoices: Array<{ invoice_id: string; month: Month; created: boolean; remainder_invoice_id: string | null }>;
			}> = [];
			const months = new Set<Month>();

			for (const item of preview.invoices) {
				adopted.push(await this.adoptOne(runner, holdingId, preview.contract, item, dto.notes ?? null, actor));
				for (const target of item.targets) months.add(target.month);
			}
			// Devengo del contrato desde el primer mes tocado (una sola vez).
			const from = [...months].sort()[0];

			if (from) await runner.query(`SELECT revenue_schedule_rebuild($1::uuid, $2::date)`, [preview.contract.id, firstDay(from)]);

			return { applied: true, contract: preview.contract, adopted };
		});
	}

	// ---------------------------------------------------------------- vista previa

	private async buildPreview(
		db: Queryable,
		holdingId: string,
		items: AdoptPreviousInvoiceItemDto[],
		contractId: string | null
	): Promise<AdoptPreview> {
		const legacy = await this.loadLegacy(db, holdingId, items);
		const clientId = legacy.find((row) => row.client_id)?.client_id ?? null;
		const client = clientId ? { id: clientId, name: legacy.find((row) => row.client_id === clientId)?.client_name ?? null } : null;
		const contracts = clientId ? await this.candidateContracts(db, holdingId, clientId) : [];
		const contract = contractId ? (contracts.find((candidate) => candidate.id === contractId) ?? null) : null;

		if (contractId && !contract) {
			const [row] = (await db.query(`SELECT id FROM contracts WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL`, [
				contractId,
				holdingId,
			])) as Row[];

			if (!row) throw new NotFoundException('Contrato no encontrado');
		}
		const schedule = contract ? await this.contractInvoices(db, holdingId, contract.id) : [];
		const invoices: AdoptPreviewItem[] = [];
		const taken = new Set<string>();

		for (const dtoItem of items) {
			const row = legacy.find((candidate) => candidate.id === dtoItem.invoice_id)!;

			invoices.push(await this.previewItem(db, holdingId, row, dtoItem, clientId, contractId, contract, schedule, taken));
		}

		return { client, contracts, contract, invoices, can_apply: Boolean(contract) && invoices.every((item) => item.can_apply) };
	}

	private async previewItem(
		db: Queryable,
		holdingId: string,
		row: LegacyRow,
		dtoItem: AdoptPreviousInvoiceItemDto,
		clientId: string | null,
		contractId: string | null,
		contract: AdoptContractCandidate | null,
		schedule: ContractInvoiceRow[],
		taken: Set<string>
	): Promise<AdoptPreviewItem> {
		const blockers: AdoptIssue[] = [];
		const warnings: AdoptIssue[] = [];
		const issueMonth = monthOf(row.issue_date);
		const months = [...new Set((dtoItem.months?.length ? dtoItem.months : issueMonth ? [issueMonth] : []) as Month[])].sort();
		const keepRemainder = dtoItem.keep_remainder === true;
		const historyMonths = (
			(await db.query(
				`SELECT DISTINCT to_char(m.period_month, 'YYYY-MM') AS month FROM mrr_legacy m WHERE m.holding_id = $1 AND m.invoice_legacy_id = $2 ORDER BY 1`,
				[holdingId, row.id]
			)) as Row[]
		).map((item) => String(item.month) as Month);

		if (row.reconciliation_status === 'migrated' || row.reconciled_invoice_id) {
			blockers.push({ code: 'already_adopted', message: 'Esta factura ya es una factura del contrato' });
		}
		if (!row.client_id) blockers.push({ code: 'no_client', message: 'La factura no tiene cliente comercial: relaciónalo primero' });
		else if (clientId && row.client_id !== clientId) {
			blockers.push({
				code: 'other_client',
				message: 'Las facturas seleccionadas son de distintos clientes comerciales: adóptalas por separado',
			});
		}
		if (!months.length) blockers.push({ code: 'no_issue_date', message: 'La factura no tiene fecha de emisión ni meses' });
		if (row.amount_invoice_currency <= 0) blockers.push({ code: 'no_amount', message: 'La factura no tiene neto' });
		if (contractId && !contract) blockers.push({ code: 'contract_other_client', message: 'El contrato es de otro cliente comercial' });

		let targets: AdoptTarget[] = [];
		let amounts: Amounts | null = null;

		if (contract && months.length && !blockers.length) {
			const resolved = months.map((month) => this.resolveTarget(month, schedule, taken));

			for (const item of resolved) blockers.push(...item.blockers);
			if (!blockers.length) {
				const contractCurrency = (contract.contract_currency ?? resolved[0].contractCurrency ?? row.invoice_currency ?? '').toUpperCase();
				const invoiceCurrency = (row.invoice_currency ?? contractCurrency).toUpperCase();
				const fx = this.resolveFx(
					row,
					contractCurrency,
					invoiceCurrency,
					resolved.map((item) => item.fx)
				);

				if (fx === null) {
					blockers.push({
						code: 'fx_missing',
						message: `La factura está en ${invoiceCurrency} y el contrato en ${contractCurrency}, y no hay tipo de cambio para convertirla`,
					});
				} else {
					const amountContract = round2(row.amount_invoice_currency / fx);
					const vatContract = round2(this.vatOf(row) / fx);
					const coverage = allocateCoverage(
						amountContract,
						resolved.map((item) => item.targetAmount)
					);

					amounts = {
						contract_currency: contractCurrency,
						invoice_currency: invoiceCurrency,
						fx_contract_to_invoice: round6(fx),
						amount_contract_currency: amountContract,
						vat_contract_currency: vatContract,
						status: adoptedStatus(row.status),
					};
					targets = resolved.map((item, index) => {
						const target = item.target!;
						const remainder =
							keepRemainder && target.kind === 'replace' && item.targetAmount !== null && item.targetAmount - coverage[index] > CENT
								? round2(item.targetAmount - coverage[index])
								: null;

						if (target.kind === 'replace' && item.targetAmount && item.targetAmount > 0 && remainder === null) {
							const diff = Math.abs(coverage[index] - item.targetAmount) / item.targetAmount;

							if (diff > AMOUNT_WARNING_PCT) {
								warnings.push({
									code: 'amount_differs',
									message: `${target.month}: la cobertura (${coverage[index]}) difiere ${Math.round(diff * 100)} % de la Por Emitir (${item.targetAmount})`,
								});
							}
						}

						return {
							...target,
							target_amount_contract_currency: item.targetAmount ?? 0,
							coverage_contract_currency: coverage[index],
							remainder_contract_currency: remainder,
						};
					});
					for (const target of targets) taken.add(`${target.kind}:${target.invoice_id}`);
				}
			}
			if (row.client_entity_id && contract.client_entity_id && row.client_entity_id !== contract.client_entity_id) {
				warnings.push({ code: 'entity_differs', message: 'La razón social de la factura no es la del contrato' });
			}
			if (row.company_id && contract.company_id && row.company_id !== contract.company_id) {
				warnings.push({ code: 'company_differs', message: 'La compañía emisora de la factura no es la del contrato' });
			}
		}

		return {
			invoice: {
				id: row.id,
				invoice_number: row.invoice_number,
				issue_date: row.issue_date,
				status: row.status,
				invoice_currency: row.invoice_currency,
				amount_invoice_currency: row.amount_invoice_currency,
				vat: this.vatOf(row),
				total_invoice_currency: row.total_invoice_currency ?? round2(row.amount_invoice_currency + this.vatOf(row)),
				entity_legal_name: row.entity_legal_name,
				client_name: row.client_name,
				company_legal_name: row.company_legal_name,
				erp_invoice_id: row.erp_invoice_id,
				has_history: row.has_history,
			},
			months,
			keep_remainder: keepRemainder,
			targets,
			amounts,
			history_months: historyMonths,
			blockers,
			warnings,
			can_apply: Boolean(contract && targets.length && amounts) && !blockers.length,
		};
	}

	/** Qué pasa con un mes: reemplazar una Por Emitir (no tomada ya por otra previa de la misma selección), crear con plantilla, o bloqueo. */
	private resolveTarget(month: Month, schedule: ContractInvoiceRow[], taken: Set<string>) {
		const blockers: AdoptIssue[] = [];
		const none = {
			blockers,
			target: null as Omit<
				AdoptTarget,
				'target_amount_contract_currency' | 'coverage_contract_currency' | 'remainder_contract_currency'
			> | null,
			fx: null as number | null,
			contractCurrency: null as string | null,
			targetAmount: null as number | null,
		};
		const inMonth = schedule.filter((invoice) => monthOf(invoice.issue_date) === month);
		const emitted = inMonth.filter((invoice) => invoice.status !== 'Por Emitir' && invoice.status !== 'Cancelada');
		const pending = inMonth.filter(
			(invoice) => invoice.status === 'Por Emitir' && !invoice.odoo_invoice_id && !taken.has(`replace:${invoice.id}`)
		);
		const erpDrafts = inMonth.filter((invoice) => invoice.status === 'Por Emitir' && invoice.odoo_invoice_id);
		const first =
			schedule
				.map((invoice) => monthOf(invoice.issue_date))
				.filter(Boolean)
				.sort()[0] ?? null;

		if (!schedule.length) {
			blockers.push({
				code: 'contract_without_invoices',
				message: 'El contrato no tiene facturas: actívalo (o genera su calendario) antes de adoptar',
			});

			return none;
		}
		if (emitted.length) {
			blockers.push({
				code: 'month_already_invoiced',
				message: `El contrato ya tiene una factura emitida en ${month} (${emitted.map((invoice) => invoice.invoice_number ?? invoice.status).join(', ')})`,
			});
		} else if (erpDrafts.length && !pending.length) {
			blockers.push({
				code: 'erp_draft',
				message: `La Por Emitir de ${month} ya está como borrador en el ERP: restablécela primero desde el contrato`,
			});
		} else if (first && month < first) {
			blockers.push({
				code: 'before_contract',
				message: `${month} es anterior al primer mes del contrato (${first}): corrige el inicio del contrato`,
			});
		}
		if (blockers.length) return none;
		if (pending.length) {
			// Varias Por Emitir en el mes (facturas por línea): la de mayor neto.
			const best = [...pending].sort((a, b) => b.amount_contract_currency - a.amount_contract_currency)[0];

			return {
				blockers,
				target: { month, kind: 'replace' as const, invoice_id: best.id, template_invoice_number: null },
				fx: best.fx_contract_to_invoice,
				contractCurrency: best.contract_currency,
				targetAmount: best.amount_contract_currency,
			};
		}
		const template = [...schedule]
			.filter((invoice) => invoice.status !== 'Cancelada')
			.sort((a, b) => Math.abs(monthDistance(monthOf(a.issue_date), month)) - Math.abs(monthDistance(monthOf(b.issue_date), month)))[0];

		return {
			blockers,
			target: {
				month,
				kind: 'create' as const,
				invoice_id: template.id,
				template_invoice_number: template.invoice_number ?? `Por Emitir ${monthOf(template.issue_date) ?? ''}`.trim(),
			},
			fx: template.fx_contract_to_invoice,
			contractCurrency: template.contract_currency,
			targetAmount: template.amount_contract_currency,
		};
	}

	private resolveFx(row: LegacyRow, contractCurrency: string, invoiceCurrency: string, fallbacks: Array<number | null>): number | null {
		if (contractCurrency === invoiceCurrency) return 1;
		if (row.fx_contract_to_invoice && row.fx_contract_to_invoice > 0) return row.fx_contract_to_invoice;
		const fallback = fallbacks.find((value) => value && value > 0);

		return fallback ?? null;
	}

	private vatOf(row: LegacyRow): number {
		if (row.vat !== null) return row.vat;
		if (row.total_invoice_currency !== null) return round2(Math.max(row.total_invoice_currency - row.amount_invoice_currency, 0));

		return 0;
	}

	// ---------------------------------------------------------------- lecturas

	private async loadLegacy(db: Queryable, holdingId: string, items: AdoptPreviousInvoiceItemDto[]): Promise<LegacyRow[]> {
		const ids = [...new Set(items.map((item) => item.invoice_id))];
		const rows = (await db.query(
			`SELECT il.id, il.invoice_number, il.issue_date, il.due_date, il.status, il.invoice_currency, il.amount_invoice_currency, il.vat,
				il.total_invoice_currency, il.fx_contract_to_invoice, COALESCE(il.client_id, ce.client_id) AS client_id, cl.name_commercial AS client_name,
				il.client_entity_id, ce.legal_name AS entity_legal_name, il.company_id, co.legal_name AS company_legal_name,
				il.odoo_integration_id AS erp_invoice_id, il.source_system, il.pdf_url, il.reconciliation_status, il.reconciled_invoice_id,
				EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_legacy_id = il.id) AS has_history
			FROM invoices_legacy il
			LEFT JOIN client_entities ce ON ce.id = il.client_entity_id
			LEFT JOIN clients cl ON cl.id = COALESCE(il.client_id, ce.client_id)
			LEFT JOIN companies co ON co.id = il.company_id
			WHERE il.holding_id = $1 AND il.id = ANY($2::uuid[])`,
			[holdingId, ids]
		)) as Row[];
		const byId = new Map(rows.map((row) => [String(row.id), row]));
		const missing = ids.filter((id) => !byId.has(id));

		if (missing.length) throw new NotFoundException(`Factura previa no encontrada: ${missing.join(', ')}`);

		return ids.map((id) => {
			const row = byId.get(id)!;

			return {
				id,
				invoice_number: str(row.invoice_number),
				issue_date: isoDate(row.issue_date),
				due_date: isoDate(row.due_date),
				status: str(row.status),
				invoice_currency: str(row.invoice_currency),
				amount_invoice_currency: num(row.amount_invoice_currency),
				vat: numOrNull(row.vat),
				total_invoice_currency: numOrNull(row.total_invoice_currency),
				fx_contract_to_invoice: numOrNull(row.fx_contract_to_invoice),
				client_id: str(row.client_id),
				client_name: str(row.client_name),
				client_entity_id: str(row.client_entity_id),
				entity_legal_name: str(row.entity_legal_name),
				company_id: str(row.company_id),
				company_legal_name: str(row.company_legal_name),
				erp_invoice_id: numOrNull(row.erp_invoice_id),
				source_system: str(row.source_system),
				pdf_url: str(row.pdf_url),
				reconciliation_status: str(row.reconciliation_status),
				reconciled_invoice_id: str(row.reconciled_invoice_id),
				has_history: row.has_history === true,
			};
		});
	}

	/** Contratos del cliente comercial (no borrados), con su rango de meses facturados y los meses con Por Emitir adoptable. */
	private async candidateContracts(db: Queryable, holdingId: string, clientId: string): Promise<AdoptContractCandidate[]> {
		const rows = (await db.query(
			`SELECT c.id, c.contract_number, c.status, c.contract_currency, c.client_entity_id, c.company_id,
				to_char(MIN(i.issue_date), 'YYYY-MM') AS first_month, to_char(MAX(i.issue_date), 'YYYY-MM') AS last_month,
				COALESCE(json_agg(DISTINCT to_char(i.issue_date, 'YYYY-MM')) FILTER (WHERE i.status = 'Por Emitir' AND i.odoo_invoice_id IS NULL), '[]'::json) AS pending_months
			FROM contracts c
			LEFT JOIN invoices i ON i.contract_id = c.id AND i.holding_id = c.holding_id AND i.is_active AND i.document_type <> 'NC'
			WHERE c.holding_id = $1 AND c.client_id = $2 AND c.deleted_at IS NULL
			GROUP BY c.id
			ORDER BY c.status = 'Activo' DESC, MAX(i.issue_date) DESC NULLS LAST, c.contract_number`,
			[holdingId, clientId]
		)) as Row[];

		return rows.map((row) => ({
			id: String(row.id),
			contract_number: str(row.contract_number),
			status: str(row.status),
			contract_currency: str(row.contract_currency),
			client_entity_id: str(row.client_entity_id),
			company_id: str(row.company_id),
			first_month: (str(row.first_month) as Month | null) ?? null,
			last_month: (str(row.last_month) as Month | null) ?? null,
			pending_months: (Array.isArray(row.pending_months) ? (row.pending_months as unknown[]) : [])
				.filter(Boolean)
				.map(String)
				.sort() as Month[],
		}));
	}

	private async contractInvoices(db: Queryable, holdingId: string, contractId: string): Promise<ContractInvoiceRow[]> {
		const rows = (await db.query(
			`SELECT i.id, i.invoice_number, i.status, i.issue_date, i.odoo_invoice_id, i.amount_contract_currency, i.vat, i.contract_currency,
				i.invoice_currency, i.fx_contract_to_invoice
			FROM invoices i WHERE i.holding_id = $1 AND i.contract_id = $2 AND i.is_active AND i.document_type <> 'NC'
			ORDER BY i.issue_date, i.created_at`,
			[holdingId, contractId]
		)) as Row[];

		return rows.map((row) => ({
			id: String(row.id),
			invoice_number: str(row.invoice_number),
			status: String(row.status),
			issue_date: isoDate(row.issue_date),
			odoo_invoice_id: numOrNull(row.odoo_invoice_id),
			amount_contract_currency: num(row.amount_contract_currency),
			vat: numOrNull(row.vat),
			contract_currency: str(row.contract_currency),
			invoice_currency: str(row.invoice_currency),
			fx_contract_to_invoice: numOrNull(row.fx_contract_to_invoice),
		}));
	}

	private async loadLines(db: Queryable, holdingId: string, invoiceId: string): Promise<AdoptSourceLine[]> {
		const rows = (await db.query(
			`SELECT ii.id, ii.contract_item_id, ii.product_id, ii.description, ii.quantity, ii.unit_of_measure, ii.discount_pct,
				ii.subtotal_contract_currency, ii.tax_amount_contract_currency, ii.tax_code, ii.billing_period_start, ii.billing_period_end,
				ii.quantity_source, ii.pricing_breakdown, ii.contract_currency
			FROM invoice_items ii WHERE ii.holding_id = $1 AND ii.invoice_id = $2 ORDER BY ii.created_at, ii.id`,
			[holdingId, invoiceId]
		)) as Row[];

		return rows.map((row) => ({
			id: String(row.id),
			contract_item_id: str(row.contract_item_id),
			product_id: str(row.product_id),
			description: str(row.description) ?? '',
			quantity: num(row.quantity),
			unit_of_measure: str(row.unit_of_measure),
			discount_pct: num(row.discount_pct),
			subtotal_contract_currency: num(row.subtotal_contract_currency),
			tax_amount_contract_currency: num(row.tax_amount_contract_currency),
			tax_code: str(row.tax_code),
			billing_period_start: isoDate(row.billing_period_start),
			billing_period_end: isoDate(row.billing_period_end),
			quantity_source: str(row.quantity_source),
			pricing_breakdown: row.pricing_breakdown ?? null,
			contract_currency: str(row.contract_currency) ?? '',
		}));
	}

	// ---------------------------------------------------------------- escritura

	private async adoptOne(
		runner: QueryRunner,
		holdingId: string,
		contract: AdoptContractCandidate,
		item: AdoptPreviewItem,
		notes: string | null,
		actor: OnboardingActor
	) {
		const amounts = item.amounts!;
		const legacy = item.invoice;
		const status = amounts.status;
		const issueDate = legacy.issue_date ?? firstDay(item.targets[0].month);
		const dueDate = await this.dueDateOf(runner, holdingId, legacy.id, issueDate);
		const fx = amounts.fx_contract_to_invoice;
		const [sourceSystem, pdfUrl] = await Promise.all([
			this.sourceSystemOf(runner, holdingId, legacy.id),
			this.pdfOf(runner, holdingId, legacy.id),
		]);
		const note = [`Adoptada desde la factura previa ${legacy.invoice_number ?? legacy.id} (${issueDate})`, notes?.trim() || null]
			.filter(Boolean)
			.join(': ');
		// IVA por mes en proporción a la cobertura.
		const vats = splitExact(
			amounts.vat_contract_currency,
			item.targets.map((target) =>
				amounts.amount_contract_currency > 0 ? target.coverage_contract_currency / amounts.amount_contract_currency : 1 / item.targets.length
			)
		);
		const invoices: Array<{ invoice_id: string; month: Month; created: boolean; remainder_invoice_id: string | null }> = [];

		for (const [index, target] of item.targets.entries()) {
			const coverage = target.coverage_contract_currency;
			const vatContract = vats[index];
			const amountInvoice = round2(coverage * fx);
			const vatInvoice = round2(vatContract * fx);
			const totalInvoice = round2(amountInvoice + vatInvoice);
			const sourceLines = await this.loadLines(runner, holdingId, target.invoice_id);
			const lines = scaleLines(sourceLines, coverage, vatContract, fx);
			let invoiceId: string;
			let remainderId: string | null = null;
			let before: Row | null = null;

			if (target.kind === 'replace') {
				invoiceId = target.invoice_id;
				[before] = (await runner.query(
					`SELECT status, invoice_number, issue_date, due_date, amount_contract_currency, amount_invoice_currency, total_invoice_currency, invoice_currency,
						contract_currency, fx_contract_to_invoice, vat
					FROM invoices WHERE id = $1 AND holding_id = $2`,
					[invoiceId, holdingId]
				)) as Row[];
				if (target.remainder_contract_currency !== null && before) {
					remainderId = await this.insertRemainder(runner, holdingId, invoiceId, before, sourceLines, target.remainder_contract_currency);
				}
				const updated = (await runner.query(
					`UPDATE invoices SET status = $3, invoice_number = $4, issue_date = $5::date, original_issue_date = COALESCE(original_issue_date, scheduled_at, $5::date),
						due_date = $6::date, invoice_currency = $7, fx_contract_to_invoice = $8,
						amount_contract_currency = $9, vat = $10, amount_invoice_currency = $11, total_invoice_currency = $12,
						is_legacy = true, legacy_invoice_id = $13, legacy_source_system = $14,
						odoo_invoice_id = COALESCE($15, odoo_invoice_id), sent_to_odoo_at = CASE WHEN $15::bigint IS NOT NULL THEN now() ELSE sent_to_odoo_at END,
						pdf_url = COALESCE($16, pdf_url),
						notes = COALESCE(notes || E'\\n', '') || $17::text
					WHERE id = $1 AND holding_id = $2 AND status = 'Por Emitir' RETURNING id`,
					[
						invoiceId,
						holdingId,
						status,
						legacy.invoice_number,
						issueDate,
						dueDate,
						amounts.invoice_currency,
						fx,
						coverage,
						vatInvoice,
						amountInvoice,
						totalInvoice,
						legacy.id,
						sourceSystem,
						legacy.erp_invoice_id,
						pdfUrl,
						note,
					]
				)) as Row[];

				if (!updated.length) throw conflict('target_changed', 'La Por Emitir cambió mientras se adoptaba: vuelve a intentarlo');
				await this.writeLines(runner, holdingId, invoiceId, lines, amounts.invoice_currency, fx, status, issueDate, 'update');
			} else {
				const [created] = (await runner.query(
					`INSERT INTO invoices (
						id, invoice_group_id, company_id, client_id, client_entity_id, contract_id,
						scheduled_at, original_issue_date, issue_date, due_date,
						vat, tax_rate, amount_contract_currency, amount_invoice_currency, total_invoice_currency,
						contract_currency, invoice_currency, fx_contract_to_invoice,
						status, invoice_number, invoice_type, document_type, export_type, invoice_series,
						holding_id, issuer_legal_name, issuer_tax_id, issuer_address, client_tax_id,
						requires_references_for_billing, auto_invoice, invoice_terms_and_conditions, payment_method, fiscal_regime, is_active,
						is_legacy, legacy_invoice_id, legacy_source_system, odoo_invoice_id, sent_to_odoo_at, pdf_url, notes
					) SELECT
						g.id, g.id, t.company_id, t.client_id, t.client_entity_id, t.contract_id,
						$4::date, $4::date, $4::date, $5::date,
						$6, t.tax_rate, $7, $8, $9,
						$10, $11, $12,
						$13, $14, 'Automatica', t.document_type, t.export_type, t.invoice_series,
						t.holding_id, t.issuer_legal_name, t.issuer_tax_id, t.issuer_address, t.client_tax_id,
						t.requires_references_for_billing, t.auto_invoice, t.invoice_terms_and_conditions, t.payment_method, t.fiscal_regime, true,
						true, $15, $16, $17, CASE WHEN $17::bigint IS NOT NULL THEN now() END, $18, $19
					FROM invoices t, (SELECT gen_random_uuid() AS id) g
					WHERE t.id = $1 AND t.holding_id = $2 AND t.contract_id = $3
					RETURNING id`,
					[
						target.invoice_id,
						holdingId,
						contract.id,
						issueDate,
						dueDate,
						vatInvoice,
						coverage,
						amountInvoice,
						totalInvoice,
						amounts.contract_currency,
						amounts.invoice_currency,
						fx,
						status,
						legacy.invoice_number,
						legacy.id,
						sourceSystem,
						legacy.erp_invoice_id,
						pdfUrl,
						note,
					]
				)) as Row[];

				if (!created) throw conflict('template_missing', 'La factura plantilla del contrato ya no existe');
				invoiceId = String(created.id);
				await this.writeLines(
					runner,
					holdingId,
					invoiceId,
					lines.map((line) => ({ ...line, billing_period_start: firstDay(target.month), billing_period_end: lastDay(target.month) })),
					amounts.invoice_currency,
					fx,
					status,
					issueDate,
					'insert'
				);
			}
			await refreshInvoiceSystemAmounts(runner, holdingId, [invoiceId, ...(remainderId ? [remainderId] : [])]);
			await runner.query(
				`INSERT INTO contract_lifecycle_events (
					contract_id, holding_id, event_type, event_status, title, description, summary, created_by, completed_at, effective_date, metadata
				) VALUES ($1, $2, $3, 'Completed', $4, $5, $5, $6, now(), $7::date, $8::jsonb)`,
				[
					contract.id,
					holdingId,
					ADOPTED_EVENT_TYPE,
					`Factura ${legacy.invoice_number ?? ''} adoptada desde facturas previas`.replace('  ', ' '),
					`${target.kind === 'replace' ? 'Reemplaza la Por Emitir' : 'Factura creada'} de ${target.month} con la factura previa ${legacy.invoice_number ?? legacy.id} (${issueDate}, ${status}, cobertura ${coverage} ${amounts.contract_currency}${target.remainder_contract_currency !== null ? `, remanente ${target.remainder_contract_currency} Por Emitir` : ''})`,
					actor.userId || null,
					issueDate,
					JSON.stringify({
						source: 'onboarding',
						invoice_id: invoiceId,
						previous_invoice_id: legacy.id,
						month: target.month,
						kind: target.kind,
						coverage_contract_currency: coverage,
						remainder_invoice_id: remainderId,
						remainder_contract_currency: target.remainder_contract_currency,
						before,
						after: {
							status,
							invoice_number: legacy.invoice_number,
							issue_date: issueDate,
							due_date: dueDate,
							amount_contract_currency: coverage,
							vat_contract_currency: vatContract,
						},
						history_months: item.history_months,
						warnings: item.warnings.map((warning) => warning.code),
						notes,
					}),
				]
			);
			invoices.push({ invoice_id: invoiceId, month: target.month, created: target.kind === 'create', remainder_invoice_id: remainderId });
		}
		await runner.query(`DELETE FROM mrr_legacy WHERE holding_id = $1 AND invoice_legacy_id = $2`, [holdingId, legacy.id]);
		await runner.query(
			`UPDATE invoices_legacy SET reconciliation_status = 'migrated', reconciled_invoice_id = $3, contract_id = $4, reconciled_at = now()
			WHERE holding_id = $1 AND id = $2`,
			[holdingId, legacy.id, invoices[0].invoice_id, contract.id]
		);
		await insertOnboardingEvent(runner, holdingId, actor.userId, {
			type: 'previous_invoice_adopted',
			entityType: 'invoice_legacy',
			entityId: legacy.id,
			payload: {
				invoice_number: legacy.invoice_number,
				contract_id: contract.id,
				contract_number: contract.contract_number,
				invoices,
				months: item.targets.map((target) => target.month),
				history_months: item.history_months,
				notes,
			},
		});

		return { previous_invoice_id: legacy.id, invoice_number: legacy.invoice_number, invoices };
	}

	/**
	 * Remanente de una cobertura parcial: una Por Emitir nueva con el neto no cubierto, copia del encabezado original (antes de
	 * reescribirlo) y sus líneas reescaladas, `split_from_invoice_id` = la original y `split_reason = 'legacy_partial'`.
	 */
	private async insertRemainder(
		runner: QueryRunner,
		holdingId: string,
		originalId: string,
		before: Row,
		sourceLines: AdoptSourceLine[],
		remainder: number
	): Promise<string> {
		const sameCurrency = (str(before.invoice_currency) ?? '').toUpperCase() === (str(before.contract_currency) ?? '').toUpperCase();
		const fx = sameCurrency ? 1 : numOrNull(before.fx_contract_to_invoice);
		const originalAmount = num(before.amount_contract_currency);
		const ratio = originalAmount > 0 ? remainder / originalAmount : 0;
		const vatContract = round2(sourceLines.reduce((sum, line) => sum + line.tax_amount_contract_currency, 0) * ratio);
		const lines = scaleLines(sourceLines, remainder, vatContract, fx ?? 1);
		const [created] = (await runner.query(
			`INSERT INTO invoices (
				id, invoice_group_id, company_id, client_id, client_entity_id, contract_id,
				scheduled_at, original_issue_date, issue_date, due_date,
				vat, tax_rate, amount_contract_currency, amount_invoice_currency, total_invoice_currency,
				contract_currency, invoice_currency, fx_contract_to_invoice,
				status, invoice_type, document_type, export_type, invoice_series,
				holding_id, issuer_legal_name, issuer_tax_id, issuer_address, client_tax_id,
				requires_references_for_billing, auto_invoice, invoice_terms_and_conditions, payment_method, fiscal_regime, is_active,
				split_from_invoice_id, split_reason, notes
			) SELECT
				g.id, t.invoice_group_id, t.company_id, t.client_id, t.client_entity_id, t.contract_id,
				t.scheduled_at, t.original_issue_date, t.issue_date, t.due_date,
				$3, t.tax_rate, $4, $5, $6,
				t.contract_currency, t.invoice_currency, t.fx_contract_to_invoice,
				'Por Emitir', t.invoice_type, t.document_type, t.export_type, t.invoice_series,
				t.holding_id, t.issuer_legal_name, t.issuer_tax_id, t.issuer_address, t.client_tax_id,
				t.requires_references_for_billing, t.auto_invoice, t.invoice_terms_and_conditions, t.payment_method, t.fiscal_regime, true,
				t.id, $7, $8
			FROM invoices t, (SELECT gen_random_uuid() AS id) g
			WHERE t.id = $1 AND t.holding_id = $2
			RETURNING id`,
			[
				originalId,
				holdingId,
				fx === null ? null : round2(vatContract * fx),
				remainder,
				fx === null ? null : round2(remainder * fx),
				fx === null ? null : round2((remainder + vatContract) * fx),
				ADOPT_REMAINDER_SPLIT_REASON,
				`Remanente Por Emitir tras adoptar una factura previa con cobertura parcial (${remainder} de ${originalAmount})`,
			]
		)) as Row[];
		const remainderId = String(created.id);

		await this.writeLines(
			runner,
			holdingId,
			remainderId,
			fx === null
				? lines.map((line) => ({
						...line,
						unit_price_invoice_currency: null,
						subtotal_invoice_currency: null,
						tax_amount_invoice_currency: null,
						total_invoice_currency: null,
					}))
				: lines,
			str(before.invoice_currency) ?? '',
			fx,
			'Por Emitir',
			isoDate(before.issue_date) ?? firstDay(monthOf(before.issue_date) ?? ('1970-01' as Month)),
			'insert'
		);

		return remainderId;
	}

	private async writeLines(
		runner: QueryRunner,
		holdingId: string,
		invoiceId: string,
		lines: Array<
			| ScaledLine
			| (Omit<
					ScaledLine,
					'unit_price_invoice_currency' | 'subtotal_invoice_currency' | 'tax_amount_invoice_currency' | 'total_invoice_currency'
			  > & {
					unit_price_invoice_currency: number | null;
					subtotal_invoice_currency: number | null;
					tax_amount_invoice_currency: number | null;
					total_invoice_currency: number | null;
			  })
		>,
		invoiceCurrency: string,
		fx: number | null,
		status: string,
		issueDate: string,
		mode: 'update' | 'insert'
	) {
		for (const line of lines) {
			if (mode === 'update') {
				await runner.query(
					`UPDATE invoice_items SET quantity = $3, unit_price_contract_currency = $4, subtotal_contract_currency = $5, tax_amount_contract_currency = $6,
						total_contract_currency = $7, unit_price_invoice_currency = $8, subtotal_invoice_currency = $9, tax_amount_invoice_currency = $10,
						total_invoice_currency = $11, invoice_currency = $12, fx_contract_to_invoice = $13, fx_rate_source = $14, fx_rate_date = $15::date,
						status = $16, issue_date = $15::date
					WHERE id = $1 AND holding_id = $2`,
					[
						line.id,
						holdingId,
						line.quantity,
						line.unit_price_contract_currency,
						line.subtotal_contract_currency,
						line.tax_amount_contract_currency,
						line.total_contract_currency,
						line.unit_price_invoice_currency,
						line.subtotal_invoice_currency,
						line.tax_amount_invoice_currency,
						line.total_invoice_currency,
						invoiceCurrency,
						fx,
						ADOPT_FX_RATE_SOURCE,
						issueDate,
						status,
					]
				);
			} else {
				await runner.query(
					`INSERT INTO invoice_items (
						invoice_id, contract_item_id, description, quantity, unit_of_measure,
						unit_price_contract_currency, unit_price_invoice_currency, discount_pct,
						subtotal_contract_currency, subtotal_invoice_currency, tax_amount_contract_currency, tax_amount_invoice_currency,
						total_contract_currency, total_invoice_currency,
						holding_id, contract_id, product_id, contract_currency, invoice_currency, fx_contract_to_invoice, fx_rate_source, fx_rate_date,
						status, issue_date, billing_period_start, billing_period_end, quantity_source, pricing_breakdown, tax_code
					) SELECT
						$1, $2::uuid, $3, $4, $5,
						$6, $7, $8,
						$9, $10, $11, $12,
						$13, $14,
						$15, h.contract_id, $16::uuid, $17, $18, $19, $20, $21::date,
						$22, $21::date, $23::date, $24::date, $25, $26::jsonb, $27
					FROM invoices h WHERE h.id = $1`,
					[
						invoiceId,
						line.contract_item_id,
						line.description,
						line.quantity,
						line.unit_of_measure ?? 'UND',
						line.unit_price_contract_currency,
						line.unit_price_invoice_currency,
						line.discount_pct,
						line.subtotal_contract_currency,
						line.subtotal_invoice_currency,
						line.tax_amount_contract_currency,
						line.tax_amount_invoice_currency,
						line.total_contract_currency,
						line.total_invoice_currency,
						holdingId,
						line.product_id,
						line.contract_currency || invoiceCurrency,
						invoiceCurrency,
						fx,
						fx === null ? null : ADOPT_FX_RATE_SOURCE,
						issueDate,
						status,
						line.billing_period_start,
						line.billing_period_end,
						line.quantity_source ?? 'fixed',
						line.pricing_breakdown === null || line.pricing_breakdown === undefined ? null : JSON.stringify(line.pricing_breakdown),
						line.tax_code,
					]
				);
			}
		}
	}

	private async dueDateOf(db: Queryable, holdingId: string, legacyId: string, issueDate: string): Promise<string> {
		const [row] = (await db.query(`SELECT due_date FROM invoices_legacy WHERE holding_id = $1 AND id = $2`, [holdingId, legacyId])) as Row[];

		return isoDate(row?.due_date) ?? isoDate(new Date(new Date(`${issueDate}T12:00:00`).getTime() + 30 * 86400000))!;
	}

	private async sourceSystemOf(db: Queryable, holdingId: string, legacyId: string): Promise<string | null> {
		const [row] = (await db.query(`SELECT source_system FROM invoices_legacy WHERE holding_id = $1 AND id = $2`, [holdingId, legacyId])) as Row[];

		return str(row?.source_system);
	}

	private async pdfOf(db: Queryable, holdingId: string, legacyId: string): Promise<string | null> {
		const [row] = (await db.query(`SELECT pdf_url FROM invoices_legacy WHERE holding_id = $1 AND id = $2`, [holdingId, legacyId])) as Row[];

		return str(row?.pdf_url);
	}
}

/** Meses entre dos `YYYY-MM` (b − a); `null` cuenta como muy lejos. */
function monthDistance(a: Month | null, b: Month): number {
	if (!a) return 10_000;
	const [ay, am] = a.split('-').map(Number);
	const [by, bm] = b.split('-').map(Number);

	return (by - ay) * 12 + (bm - am);
}

function lastDay(month: Month): string {
	const date = new Date(`${nextMonthStart(month)}T12:00:00`);

	date.setDate(date.getDate() - 1);

	return isoDate(date)!;
}
