import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { withApiWriter } from '@/modules/contracts/api-writer';
import { ContractDraftsService } from '@/modules/contracts/contract-drafts.service';
import type { CreateContractDto } from '@/modules/contracts/dtos/create-contract.dto';
import { type Month, monthRange, monthsBetween } from '@/modules/metrics/metrics-period';

import {
	HISTORY_ITEM_CATEGORY,
	insertOnboardingEvent,
	isoDate,
	monthOf,
	nextMonthStart,
	normalizeName,
	num,
	numOrNull,
	type OnboardingActor,
	type Queryable,
	round2,
	round6,
	type Row,
	str,
} from './onboarding-common';
import { OnboardingRegisterService, type RegisterError, type RegisterWarning } from './onboarding-register.service';

import type { QuickStartApplyDto, QuickStartPreviewDto, QuickStartProposalDto } from './dtos/onboarding.dto';

export type QuickStartFlag = 'no_client' | 'no_product' | 'already_has_contract' | 'multi_currency';

/**
 * Arranque rápido (§3.3): por razón social, la **última factura previa** hasta el mes de corte define el estado vigente. La vista previa
 * muestra esa factura, sus líneas y avisos; **no inventa producto ni período** (solo propone el producto del catálogo cuyo código o
 * nombre calza exacto con la línea). Al aplicar, la usuaria manda por cliente lo de "Registrar histórico" (§3.2b: período, monto en
 * moneda de contrato, productos) más frecuencia y método: se crea el contrato En revisión con el generador común
 * (`ContractDraftsService.create`, un ítem por producto) y, en una segunda transacción, las filas de MRR histórico de esa factura ya
 * empalmadas al contrato (`OnboardingRegisterService.registerInTx`: un registro —`batch_id`— nuevo por cliente × moneda, Domi 18-10). Si el
 * registro falla, el borrador recién creado se elimina.
 */
@Injectable()
export class OnboardingQuickStartService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly contractDrafts: ContractDraftsService,
		private readonly register: OnboardingRegisterService
	) {}

	/** Última factura por razón social con fecha de emisión anterior al mes siguiente al corte. */
	private async lastInvoices(db: Queryable, holdingId: string, asOf: Month, entityIds: string[] | undefined, historyMonths: number) {
		return (await db.query(
			`WITH last AS (
				SELECT DISTINCT ON (il.client_entity_id) il.id, il.client_entity_id, il.invoice_number, il.issue_date, il.total_invoice_currency,
					il.amount_invoice_currency, il.invoice_currency, il.company_id
				FROM invoices_legacy il
				WHERE il.holding_id = $1 AND il.client_entity_id IS NOT NULL AND il.issue_date < $2::date
					AND ($3::uuid[] IS NULL OR il.client_entity_id = ANY($3::uuid[]))
				ORDER BY il.client_entity_id, il.issue_date DESC, il.created_at DESC NULLS LAST
			)
			SELECT last.*, ce.legal_name, COALESCE(ce.client_id,
					(SELECT x.client_id FROM client_entity_clients x WHERE x.client_entity_id = ce.id ORDER BY x.is_primary DESC, x.created_at LIMIT 1)) AS client_id,
				cl.name_commercial AS client_name,
				EXISTS (SELECT 1 FROM contracts c WHERE c.holding_id = $1 AND c.client_entity_id = ce.id AND c.deleted_at IS NULL AND c.status <> 'Cancelado')
					AS already_has_contract,
				(SELECT COUNT(DISTINCT i2.invoice_currency) FROM invoices_legacy i2
					WHERE i2.holding_id = $1 AND i2.client_entity_id = ce.id AND i2.issue_date < $2::date) AS currencies,
				(SELECT COUNT(DISTINCT date_trunc('month', i3.issue_date)) FROM invoices_legacy i3
					WHERE i3.holding_id = $1 AND i3.client_entity_id = ce.id AND i3.issue_date < date_trunc('month', last.issue_date)
						AND i3.issue_date >= date_trunc('month', last.issue_date) - make_interval(months => $4::int)) AS history_months_found
			FROM last
			JOIN client_entities ce ON ce.id = last.client_entity_id
			LEFT JOIN clients cl ON cl.id = COALESCE(ce.client_id,
				(SELECT x.client_id FROM client_entity_clients x WHERE x.client_entity_id = ce.id ORDER BY x.is_primary DESC, x.created_at LIMIT 1))
			ORDER BY ce.legal_name`,
			[holdingId, nextMonthStart(asOf), entityIds?.length ? entityIds : null, historyMonths]
		)) as Row[];
	}

	async preview(holdingId: string, dto: QuickStartPreviewDto) {
		const invoices = await this.lastInvoices(this.dataSource, holdingId, dto.as_of, dto.entity_ids, dto.history_months ?? 0);
		const ids = invoices.map((row) => String(row.id));
		// Lo que la usuaria ya completó (opcional): mismo motor que al aplicar, para mostrar tipo de cambio, avisos y errores.
		const completed = new Map((dto.proposals ?? []).map((proposal) => [proposal.entity_id, proposal]));
		const withInput = invoices.filter((invoice) => completed.has(String(invoice.client_entity_id)));
		const plans = withInput.length
			? await this.register.plan(
					this.dataSource,
					holdingId,
					withInput.map((invoice) => this.registerInput(completed.get(String(invoice.client_entity_id))!, String(invoice.id)))
				)
			: [];
		const planByInvoice = new Map(plans.map((plan) => [plan.invoice_id, plan]));
		// Registros pendientes del cliente en la moneda completada (Domi 18-10): el arranque crea un registro nuevo por cliente × moneda; esto
		// avisa que ya hay historia pendiente de ese cliente. Solo con lo completado por la usuaria.
		const records = await this.register.recordsOf(this.dataSource, holdingId, plans);
		const recordsByInvoice = new Map(plans.map((plan, index) => [plan.invoice_id, records.rows[index].existing_records]));
		const [items, products] = await Promise.all([
			ids.length
				? (this.dataSource.query(
						`SELECT invoices_legacy_id, description, product_external_code, quantity, unit_price, subtotal
						FROM invoice_items_legacy WHERE holding_id = $1 AND invoices_legacy_id = ANY($2::uuid[]) ORDER BY created_at, id`,
						[holdingId, ids]
					) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
			this.dataSource.query(`SELECT id, name, product_code FROM products WHERE holding_id = $1`, [holdingId]) as Promise<Row[]>,
		]);
		const proposals = invoices.map((invoice) => {
			const lines = items.filter((item) => String(item.invoices_legacy_id) === String(invoice.id));
			const mapped = lines.map((item) => {
				const code = str(item.product_external_code);
				const description = str(item.description);
				const byCode = code ? products.find((product) => str(product.product_code) === code) : undefined;
				const byName = description ? products.find((product) => normalizeName(product.name) === normalizeName(description)) : undefined;
				const quantity = num(item.quantity) || 1;

				return {
					description,
					quantity,
					unit_price: numOrNull(item.unit_price) ?? round6(num(item.subtotal) / quantity),
					subtotal: num(item.subtotal),
					product_id: byCode ? String(byCode.id) : null,
					product_suggestion: byCode || byName ? { id: String((byCode ?? byName)!.id), name: str((byCode ?? byName)!.name) } : null,
				};
			});
			const flags: QuickStartFlag[] = [];

			if (!invoice.client_id) flags.push('no_client');
			if (!mapped.length || mapped.some((item) => !item.product_id)) flags.push('no_product');
			if (invoice.already_has_contract === true) flags.push('already_has_contract');
			if (num(invoice.currencies) > 1) flags.push('multi_currency');
			const month = monthOf(invoice.issue_date)!;
			const plan = planByInvoice.get(String(invoice.id));

			return {
				entity: { id: String(invoice.client_entity_id), legal_name: str(invoice.legal_name) },
				client: invoice.client_id ? { id: String(invoice.client_id), name: str(invoice.client_name) } : null,
				last_invoice: {
					id: String(invoice.id),
					number: str(invoice.invoice_number),
					issue_date: isoDate(invoice.issue_date),
					total: num(invoice.total_invoice_currency),
					amount: num(invoice.amount_invoice_currency),
					currency: str(invoice.invoice_currency),
				},
				items: mapped,
				// Sugerencia por defecto; el período real lo indica la usuaria al aplicar (§3.2b).
				contract: {
					start_date: nextMonthStart(month),
					currency: str(invoice.invoice_currency),
					billing_frequency: 'Mensual',
					billing_method: 'Anticipado',
				},
				history_months_found: num(invoice.history_months_found),
				flags,
				// Tipo de cambio visible (Domi 14-10). Sin lo completado por la usuaria, la propuesta es en la moneda de la factura (fx 1).
				invoice_currency: str(invoice.invoice_currency),
				amount_invoice_currency: num(invoice.amount_invoice_currency),
				fx_contract_to_invoice: plan ? plan.fx_contract_to_invoice : 1,
				existing_records: recordsByInvoice.get(String(invoice.id)) ?? [],
				warnings: (plan?.warnings ?? []) as RegisterWarning[],
				errors: (plan?.errors ?? []) as RegisterError[],
			};
		});
		const byCurrency = new Map<string, { currency: string; count: number; total: number }>();

		for (const proposal of proposals) {
			const key = proposal.last_invoice.currency ?? '—';
			const entry = byCurrency.get(key) ?? { currency: key, count: 0, total: 0 };

			entry.count += 1;
			entry.total = round2(entry.total + proposal.last_invoice.total);
			byCurrency.set(key, entry);
		}
		const flagged = (flag: QuickStartFlag) => proposals.filter((proposal) => proposal.flags.includes(flag)).length;

		return {
			proposals,
			summary: {
				proposals: proposals.length,
				ready: proposals.filter((proposal) => !proposal.flags.includes('no_client')).length,
				flags: {
					no_client: flagged('no_client'),
					no_product: flagged('no_product'),
					already_has_contract: flagged('already_has_contract'),
					multi_currency: flagged('multi_currency'),
				},
				by_currency: [...byCurrency.values()],
				// Un registro nuevo (`batch_id`) por propuesta aplicable (cliente × moneda).
				records_to_create: records.to_create,
			},
		};
	}

	async apply(holdingId: string, dto: QuickStartApplyDto, actor: OnboardingActor) {
		const created: Array<{
			entity_id: string;
			contract: { id: string; contract_number: string | null };
			history_rows: number;
			/** Registro relacionado nuevo (su `batch_id` × cliente × moneda × contrato creado). */
			record_key: string | null;
		}> = [];
		const skipped: Array<{ entity_id: string; reason: string; message?: string }> = [];
		const invoices = await this.lastInvoices(
			this.dataSource,
			holdingId,
			dto.as_of,
			dto.proposals.map((proposal) => proposal.entity_id),
			0
		);
		const byEntity = new Map(invoices.map((row) => [String(row.client_entity_id), row]));

		for (const proposal of dto.proposals) {
			const invoice = byEntity.get(proposal.entity_id);

			if (!invoice) {
				skipped.push({
					entity_id: proposal.entity_id,
					reason: 'no_invoice',
					message: 'La razón social no tiene facturas previas hasta el mes de corte',
				});
				continue;
			}
			if (!invoice.client_id) {
				skipped.push({ entity_id: proposal.entity_id, reason: 'no_client', message: 'La razón social no tiene cliente comercial' });
				continue;
			}
			if (!proposal.products.length) {
				skipped.push({ entity_id: proposal.entity_id, reason: 'no_product', message: 'Elige al menos un producto del catálogo' });
				continue;
			}
			const registerInput = this.registerInput(proposal, String(invoice.id));
			const [plan] = await this.register.plan(this.dataSource, holdingId, [registerInput]);
			const blocker = this.register.blockerOf(plan);

			if (blocker) {
				skipped.push({ entity_id: proposal.entity_id, reason: blocker });
				continue;
			}
			let contract: Row;

			try {
				contract = (await this.contractDrafts.create(this.contractDto(proposal, invoice), holdingId, actor.authId)) as Row;
			} catch (error) {
				skipped.push({ entity_id: proposal.entity_id, reason: 'contract_error', message: (error as Error).message });
				continue;
			}
			const contractId = String(contract.id);

			try {
				const result = await withApiWriter(this.dataSource, async (runner) => {
					const registered = await this.register.registerInTx(runner, holdingId, [registerInput], actor, { contractId });

					if (!registered.created_rows) throw new Error(registered.skipped[0]?.reason ?? 'no_history_rows');
					await insertOnboardingEvent(runner, holdingId, actor.userId, {
						type: 'quick_start_applied',
						entityType: 'client_entity',
						entityId: proposal.entity_id,
						payload: {
							as_of: dto.as_of,
							invoice_id: String(invoice.id),
							contract_id: contractId,
							contract_number: str(contract.contract_number),
							batch_id: registered.batch_ids[0] ?? null,
							history_rows: registered.created_rows,
						},
					});

					return registered;
				});

				created.push({
					entity_id: proposal.entity_id,
					contract: { id: contractId, contract_number: str(contract.contract_number) },
					history_rows: result.created_rows,
					record_key: result.records_touched[0] ?? null,
				});
			} catch (error) {
				await this.contractDrafts.remove(contractId, holdingId, actor.authId).catch(() => undefined);
				skipped.push({ entity_id: proposal.entity_id, reason: 'history_error', message: (error as Error).message });
			}
		}

		return { created, skipped };
	}

	private registerInput(proposal: QuickStartProposalDto, invoiceId: string) {
		return {
			invoice_id: invoiceId,
			period_from: proposal.period_from,
			period_to: proposal.period_to,
			contract_currency: proposal.contract_currency,
			amount_contract_currency: proposal.amount_contract_currency,
			is_recurring: true,
			products: proposal.products.map((product) => ({
				product_id: product.product_id,
				amount_contract_currency: product.amount_contract_currency,
			})),
		};
	}

	/**
	 * Contrato En revisión: un ítem por producto (cantidad y unitario si vienen; si no, cantidad 1 y unitario = monto mensual del
	 * producto), inicio = mes siguiente al período que cubre la última factura (o al de su emisión, si es posterior).
	 */
	contractDto(proposal: QuickStartProposalDto, invoice: Row): CreateContractDto {
		const months = Math.max(1, monthRange(proposal.period_from, proposal.period_to).length);
		const invoiceMonth = monthOf(invoice.issue_date)!;
		const lastCovered = monthsBetween(invoiceMonth, proposal.period_to) >= 0 ? proposal.period_to : invoiceMonth;

		return {
			client_id: String(invoice.client_id),
			client_entity_id: String(invoice.client_entity_id),
			company_id: String(invoice.company_id),
			contract_currency: proposal.contract_currency,
			items: proposal.products.map((product, index) => {
				const quantity = product.quantity ?? 1;

				return {
					key: `qs-${index + 1}`,
					product_id: product.product_id,
					item_type: 'Fijo',
					quantity,
					unit_price: product.unit_price ?? round6(product.amount_contract_currency / months / quantity),
					billing_frequency: proposal.billing_frequency ?? 'Mensual',
					billing_method: proposal.billing_method ?? 'Anticipado',
					start_date: nextMonthStart(lastCovered),
					term_months: proposal.term_months ?? 12,
					is_recurring: true,
					// Viene de algo que ya existía (Domi 14-10).
					category: HISTORY_ITEM_CATEGORY,
				};
			}),
		} as CreateContractDto;
	}
}
