import { randomUUID } from 'crypto';

import { HttpException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';
import { ContractInvoicesService } from '@/modules/contracts/contract-invoices.service';

import { type BillingBlocker, type FanOutInvoice, type FanOutResult, groupByContract, resultsFromContractBulk, withAction } from './billing-states';

import type { ToIssueErpResetDto, ToIssueFxDto, ToIssueRescheduleDto, ToIssueSendNowDto } from './dtos/billing.dto';

type Row = Record<string, unknown>;
type BulkResponse = Parameters<typeof resultsFromContractBulk>[3];

export type FanOutOperation = 'send_now' | 'reschedule' | 'fx' | 'erp_reset';

/** Cuerpo de un error de Nest (409 `{ code: 'blocked', blockers, preview }`, 404, 400 `{ message, errors }`). */
const errorBody = (error: unknown): Record<string, unknown> | null => {
	if (!(error instanceof HttpException)) return null;
	const body = error.getResponse();

	return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : { message: String(body) };
};

/**
 * Acciones masivas de la cola Por emitir **entre contratos** (spec §4.7, §5.2): agrupa `invoice_ids` por `contract_id` y llama, en serie, al
 * servicio del contrato (`ContractInvoicesService`: `send-now` por factura, `reschedule-bulk`, `fx-bulk`, `erp-reset` masivo) con el mismo
 * cuerpo. Ninguna lógica de factura nueva: bloqueos, transacción, `setApiWriter`, eventos y `bulk_id` por contrato son los del 360. Un
 * contrato que falla no detiene a los demás; la respuesta trae un resultado por factura.
 */
@Injectable()
export class BillingBulkService {
	private readonly logger = new Logger(BillingBulkService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly contractInvoices: ContractInvoicesService
	) {}

	async sendNow(holdingId: string, dto: ToIssueSendNowDto, authId: string, preview: boolean) {
		return await this.fanOut('send_now', holdingId, dto.invoice_ids, preview, async (contractId, ids, numbers) => {
			const results: FanOutResult[] = [];

			for (const invoiceId of ids) {
				try {
					const response = preview
						? await this.contractInvoices.previewSendNow(contractId, invoiceId, holdingId)
						: await this.contractInvoices.sendNow(contractId, invoiceId, { reason: dto.reason, notes: dto.notes }, holdingId, authId);
					const blockers = (response.blockers ?? []) as BillingBlocker[];
					const sent = preview ? blockers.length === 0 : (response as { sent?: boolean }).sent === true;

					results.push({
						invoice_id: invoiceId,
						invoice_number: numbers.get(invoiceId) ?? null,
						contract_id: contractId,
						ok: sent,
						blockers: blockers.map(withAction),
						warnings: (response.warnings ?? []) as FanOutResult['warnings'],
						message: preview ? null : ((response as { message?: string }).message ?? null),
					});
				} catch (error) {
					results.push(...this.failure(contractId, [invoiceId], numbers, error));
				}
			}

			return results;
		});
	}

	async reschedule(holdingId: string, dto: ToIssueRescheduleDto, authId: string, preview: boolean) {
		return await this.fanOut('reschedule', holdingId, dto.invoice_ids, preview, async (contractId, ids, numbers) => {
			const body = { invoice_ids: ids, shift_months: dto.shift_months, issue_date: dto.issue_date, reason: dto.reason, notes: dto.notes };

			try {
				const response = preview
					? await this.contractInvoices.previewRescheduleBulk(contractId, body, holdingId)
					: await this.contractInvoices.rescheduleBulk(contractId, body, holdingId, authId);

				return resultsFromContractBulk(contractId, ids, numbers, response as BulkResponse);
			} catch (error) {
				return this.failure(contractId, ids, numbers, error);
			}
		});
	}

	async fx(holdingId: string, dto: ToIssueFxDto, authId: string, preview: boolean) {
		if (dto.policy === 'net_exact' && new Set(dto.invoice_ids).size !== 1) {
			throw validationException([{ field: 'policy', message: 'El neto exacto se aplica a una factura a la vez' }]);
		}

		return await this.fanOut('fx', holdingId, dto.invoice_ids, preview, async (contractId, ids, numbers) => {
			const body = {
				invoice_ids: ids,
				policy: dto.policy,
				rate: dto.rate,
				target_net_amount: dto.target_net_amount,
				rates_by_pair: dto.rates_by_pair,
				reason: dto.reason,
				notes: dto.notes,
			};

			try {
				const response = preview
					? await this.contractInvoices.previewFxBulk(contractId, body, holdingId)
					: await this.contractInvoices.fxBulk(contractId, body, holdingId, authId);

				return resultsFromContractBulk(contractId, ids, numbers, response as BulkResponse);
			} catch (error) {
				return this.failure(contractId, ids, numbers, error);
			}
		});
	}

	async erpReset(holdingId: string, dto: ToIssueErpResetDto, authId: string) {
		return await this.fanOut('erp_reset', holdingId, dto.invoice_ids, false, async (contractId, ids, numbers) => {
			try {
				const response = await this.contractInvoices.erpResetBulk(
					contractId,
					{ invoice_ids: ids, reason: dto.reason, notes: dto.notes },
					holdingId,
					authId
				);

				return resultsFromContractBulk(contractId, ids, numbers, response as BulkResponse);
			} catch (error) {
				return this.failure(contractId, ids, numbers, error);
			}
		});
	}

	// ---------------------------------------------------------------- infraestructura

	private async fanOut(
		operation: FanOutOperation,
		holdingId: string,
		invoiceIds: string[],
		preview: boolean,
		perContract: (contractId: string, ids: string[], numbers: Map<string, string | null>) => Promise<FanOutResult[]>
	) {
		const rows = (await this.dataSource.query(
			`SELECT id, contract_id, invoice_number FROM invoices WHERE holding_id = $1 AND id = ANY($2::uuid[])`,
			[holdingId, [...new Set(invoiceIds)]]
		)) as Row[];
		const invoices: FanOutInvoice[] = rows.map((row) => ({
			id: String(row.id),
			contract_id: row.contract_id ? String(row.contract_id) : null,
			invoice_number: row.invoice_number ? String(row.invoice_number) : null,
		}));
		const numbers = new Map(invoices.map((invoice) => [invoice.id, invoice.invoice_number]));
		const { groups, orphans } = groupByContract(invoiceIds, invoices);
		const results: FanOutResult[] = orphans.map((orphan) => ({
			invoice_id: orphan.invoice_id,
			invoice_number: numbers.get(orphan.invoice_id) ?? null,
			contract_id: null,
			ok: false,
			blockers: orphan.blockers,
			warnings: [],
		}));

		// En serie: cada contrato abre su propia transacción con el contrato bloqueado (como el 360).
		for (const group of groups) results.push(...(await perContract(group.contract_id, group.invoice_ids, numbers)));
		const order = new Map([...new Set(invoiceIds)].map((id, index) => [id, index]));

		results.sort((a, b) => (order.get(a.invoice_id) ?? 0) - (order.get(b.invoice_id) ?? 0));

		return {
			bulk_id: randomUUID(),
			operation,
			preview,
			contracts: groups.length,
			results,
			summary: { ok: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length },
		};
	}

	/** Un contrato rechazó la operación: 409 con `preview.skipped` → por factura; si no, el mismo error para todas sus facturas. */
	private failure(contractId: string, ids: string[], numbers: Map<string, string | null>, error: unknown): FanOutResult[] {
		const body = errorBody(error);

		if (!body) {
			this.logger.warn(`Fan-out sobre el contrato ${contractId} falló: ${error instanceof Error ? error.message : String(error)}`);

			return ids.map((id) => ({
				invoice_id: id,
				invoice_number: numbers.get(id) ?? null,
				contract_id: contractId,
				ok: false,
				blockers: [{ code: 'error', message: 'No se pudo aplicar en este contrato', next_step: null, action: null }],
				warnings: [],
			}));
		}
		const preview = body.preview as BulkResponse | undefined;
		const blockers = (Array.isArray(body.blockers) ? body.blockers : []) as BillingBlocker[];
		const fallback: BillingBlocker[] = blockers.length
			? blockers
			: [{ code: String(body.code ?? 'error'), message: String(body.message ?? 'No se pudo aplicar'), next_step: null }];

		// El 409 del contrato no aplicó nada: ninguna queda ok aunque la vista previa la diera por aplicable.
		return resultsFromContractBulk(contractId, ids, numbers, preview ? { ...preview, updated: [] } : null, fallback).map((result) => ({
			...result,
			ok: false,
			blockers: result.blockers.length && result.blockers[0].code !== 'not_applied' ? result.blockers : fallback.map(withAction),
			message: String(body.message ?? ''),
		}));
	}
}
