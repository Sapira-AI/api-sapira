import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';

import { ExchangeRatesService } from '../banco-central/services/exchange-rates.service';
import { CreateDraftInvoiceDTO, InvoiceLineItemDTO } from '../odoo/dtos/odoo.dto';
import { Company } from '../odoo/entities/companies.entity';
import { Product } from '../odoo/entities/products.entity';
import { OdooInvoicesService } from '../odoo/odoo-invoices.service';

import { InvoiceResultDto, ProcessInvoicesResponseDto, ProcessInvoicesSummaryDto } from './dtos/send-invoices.dto';
import { InvoiceItem } from './entities/invoice-item.entity';
import { Invoice } from './entities/invoice.entity';
import { InvoiceNotificationService } from './invoice-notification.service';

interface InvoiceWithRelations extends Invoice {
	clientEntity?: ClientEntity;
	company?: Company;
	items?: InvoiceItem[];
}

interface ProcessOptions {
	dryRun: boolean;
	holdingId?: string;
}

@Injectable()
export class InvoiceSchedulerService {
	private readonly logger = new Logger(InvoiceSchedulerService.name);

	constructor(
		@InjectRepository(Invoice)
		private readonly invoiceRepository: Repository<Invoice>,
		@InjectRepository(InvoiceItem)
		private readonly invoiceItemRepository: Repository<InvoiceItem>,
		@InjectRepository(ClientEntity)
		private readonly clientEntityRepository: Repository<ClientEntity>,
		@InjectRepository(Company)
		private readonly companyRepository: Repository<Company>,
		@InjectRepository(Product)
		private readonly productRepository: Repository<Product>,
		private readonly odooInvoicesService: OdooInvoicesService,
		private readonly invoiceNotificationService: InvoiceNotificationService,
		private readonly exchangeRatesService: ExchangeRatesService
	) {}

	async processInvoicesToSend(options: ProcessOptions): Promise<ProcessInvoicesResponseDto> {
		const { dryRun, holdingId } = options;
		const startTime = Date.now();

		this.logger.log(`🚀 Iniciando procesamiento de facturas - DryRun: ${dryRun}, HoldingId: ${holdingId || 'todos'}`);

		const results: InvoiceResultDto[] = [];
		const summary: ProcessInvoicesSummaryDto = {
			total: 0,
			sent: 0,
			errors: 0,
			skipped: 0,
		};

		try {
			const invoices = await this.getInvoicesToSend(holdingId);
			summary.total = invoices.length;

			this.logger.log(`📋 Encontradas ${invoices.length} facturas para procesar`);

			for (const invoice of invoices) {
				const result = await this.sendInvoiceToOdoo(invoice, dryRun);
				results.push(result);

				if (result.status === 'sent') {
					summary.sent++;
				} else if (result.status === 'error') {
					summary.errors++;
				} else {
					summary.skipped++;
				}
			}

			const executionTime = Date.now() - startTime;
			this.logger.log(
				`✓ Procesamiento completado en ${(executionTime / 1000).toFixed(2)}s - ` +
					`Total: ${summary.total}, Enviadas: ${summary.sent}, Errores: ${summary.errors}, Omitidas: ${summary.skipped}`
			);

			return {
				success: summary.errors < summary.total,
				dryRun,
				summary,
				results,
				executedAt: new Date(),
			};
		} catch (error) {
			this.logger.error('✗ Error crítico en procesamiento de facturas:', error);
			throw error;
		}
	}

	async getInvoicesToSend(holdingId?: string): Promise<InvoiceWithRelations[]> {
		const query = this.invoiceRepository
			.createQueryBuilder('inv')
			.leftJoin('client_entities', 'cle', 'cle.id = inv.client_entity_id')
			.leftJoin('companies', 'com', 'com.id = inv.company_id')
			.where('inv.status = :status', { status: 'Por Emitir' })
			.andWhere('inv.issue_date <= CURRENT_DATE')
			.andWhere('cle.odoo_partner_id IS NOT NULL')
			.andWhere('com.odoo_integration_id IS NOT NULL')
			.orderBy('inv.issue_date', 'ASC')
			.addOrderBy('inv.created_at', 'ASC');

		if (holdingId) {
			query.andWhere('inv.holding_id = :holdingId', { holdingId });
		}

		const invoices = await query.getMany();

		for (const invoice of invoices) {
			const clientEntity = await this.clientEntityRepository.findOne({
				where: { id: invoice.client_entity_id },
			});

			const company = await this.companyRepository.findOne({
				where: { id: invoice.company_id },
			});

			const items = await this.invoiceItemRepository.find({
				where: { invoice_id: invoice.id },
			});

			(invoice as InvoiceWithRelations).clientEntity = clientEntity;
			(invoice as InvoiceWithRelations).company = company;
			(invoice as InvoiceWithRelations).items = items;
		}

		return invoices as InvoiceWithRelations[];
	}

	async sendInvoiceToOdoo(invoice: InvoiceWithRelations, dryRun: boolean): Promise<InvoiceResultDto> {
		const result: InvoiceResultDto = {
			invoiceId: invoice.id,
			invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
			status: 'skipped',
		};

		try {
			const validation = this.validateInvoiceForOdoo(invoice);
			if (!validation.valid) {
				result.status = 'skipped';
				result.error = validation.error;
				result.details = 'Factura no cumple criterios de validación';
				this.logger.warn(`⚠️ Factura ${invoice.id} omitida: ${validation.error}`);
				return result;
			}

			// NUEVO: Calcular montos si hay conversión de moneda
			if (invoice.contract_currency !== invoice.invoice_currency) {
				try {
					await this.calculateInvoiceAmountsAtIssue(invoice);

					// Recargar invoice con valores actualizados
					invoice = await this.getInvoiceWithRelations(invoice.id);
				} catch (error) {
					result.status = 'skipped';
					result.error = error.message;
					result.details = 'No se pudo calcular tipo de cambio. Se ha enviado notificación por email.';
					this.logger.error(`✗ Factura ${invoice.invoice_number} omitida: ${error.message}`);
					return result;
				}
			}

			// Validar que montos estén calculados
			if (!invoice.amount_invoice_currency && invoice.contract_currency !== invoice.invoice_currency) {
				result.status = 'skipped';
				result.error = 'Montos no calculados en moneda de facturación';
				result.details = 'La factura requiere conversión de moneda pero los montos no están calculados';
				this.logger.error(`✗ Factura ${invoice.invoice_number} omitida: montos no calculados`);
				return result;
			}

			const odooInvoiceData = await this.mapInvoiceToOdooFormat(invoice);

			if (dryRun) {
				result.status = 'sent';
				result.details = `DRY RUN - Factura se enviaría a Odoo con partner_id: ${odooInvoiceData.partner_id}`;
				this.logger.log(`🔍 DRY RUN - Factura ${invoice.invoice_number} (${invoice.id}) se enviaría a Odoo`);
				return result;
			}

			this.logger.log(`📤 Enviando factura ${invoice.invoice_number} a Odoo...`);

			const odooResponse = await this.odooInvoicesService.createDraftInvoice(invoice.holding_id, odooInvoiceData);

			if (odooResponse.success && odooResponse.invoice_id) {
				await this.invoiceRepository.update(invoice.id, {
					status: 'Enviada',
					odoo_invoice_id: odooResponse.invoice_id,
					sent_to_odoo_at: new Date(),
				});

				result.status = 'sent';
				result.odooInvoiceId = odooResponse.invoice_id;
				result.details = `Factura enviada exitosamente a Odoo con ID: ${odooResponse.invoice_id}`;
				this.logger.log(`✓ Factura ${invoice.invoice_number} enviada exitosamente (Odoo ID: ${odooResponse.invoice_id})`);
			} else {
				result.status = 'error';
				result.error = odooResponse.message || 'Error desconocido al crear factura en Odoo';
				this.logger.error(`✗ Error al enviar factura ${invoice.invoice_number}: ${result.error}`);
			}
		} catch (error) {
			result.status = 'error';
			result.error = error.message || 'Error inesperado';
			this.logger.error(`✗ Excepción al procesar factura ${invoice.invoice_number}:`, error);
		}

		return result;
	}

	async mapInvoiceToOdooFormat(invoice: InvoiceWithRelations): Promise<CreateDraftInvoiceDTO> {
		const invoiceLines: InvoiceLineItemDTO[] = [];

		for (const item of invoice.items || []) {
			let odooProductId = 1;

			if (item.product_id) {
				const product = await this.productRepository.findOne({
					where: { id: item.product_id },
				});
				if (product?.odoo_product_id) {
					odooProductId = product.odoo_product_id;
				}
			}

			const taxIds = this.mapTaxCodeToOdooIds(item.tax_code);

			invoiceLines.push({
				product_id: odooProductId,
				name: item.description || 'Producto/Servicio',
				quantity: parseFloat(item.quantity?.toString() || '1'),
				price_unit: parseFloat(item.unit_price_invoice_currency?.toString() || '0'),
				discount: parseFloat(item.discount_pct?.toString() || '0'),
				tax_ids: taxIds,
			});
		}

		const currencyId = this.mapCurrencyToOdooId(invoice.invoice_currency);

		// Convertir fechas de forma segura (pueden venir como strings desde PostgreSQL)
		const issueDateStr =
			invoice.issue_date instanceof Date
				? invoice.issue_date.toISOString().split('T')[0]
				: invoice.issue_date
					? String(invoice.issue_date).split('T')[0]
					: undefined;

		const dueDateStr =
			invoice.due_date instanceof Date
				? invoice.due_date.toISOString().split('T')[0]
				: invoice.due_date
					? String(invoice.due_date).split('T')[0]
					: undefined;

		return {
			partner_id: invoice.clientEntity.odoo_partner_id,
			company_id: invoice.company.odoo_integration_id,
			move_type: 'out_invoice',
			invoice_date: issueDateStr,
			invoice_date_due: dueDateStr,
			payment_reference: invoice.invoice_number || undefined,
			invoice_origin: invoice.contract_id || undefined,
			narration: invoice.notes || undefined,
			x_sapira_invoice_id: invoice.id,
			currency_id: currencyId,
			invoice_line_ids: invoiceLines,
		};
	}

	validateInvoiceForOdoo(invoice: InvoiceWithRelations): { valid: boolean; error?: string } {
		if (!invoice.client_entity_id) {
			return { valid: false, error: 'Factura no tiene client_entity_id' };
		}

		if (!invoice.clientEntity?.odoo_partner_id) {
			return { valid: false, error: 'Cliente no tiene odoo_partner_id' };
		}

		if (!invoice.company_id) {
			return { valid: false, error: 'Factura no tiene company_id' };
		}

		if (!invoice.company?.odoo_integration_id) {
			return { valid: false, error: 'Company no tiene odoo_integration_id' };
		}

		if (!invoice.items || invoice.items.length === 0) {
			return { valid: false, error: 'Factura no tiene items' };
		}

		if (!invoice.invoice_currency) {
			return { valid: false, error: 'Factura no tiene invoice_currency' };
		}

		return { valid: true };
	}

	async calculateInvoiceAmountsAtIssue(invoice: InvoiceWithRelations): Promise<{
		success: boolean;
		usedFallback: boolean;
		exchangeRate?: number;
		fallbackDate?: Date;
	}> {
		this.logger.log(`Calculando montos para factura ${invoice.invoice_number} (${invoice.id})`);

		try {
			const exchangeRateResult = await this.exchangeRatesService.getExchangeRateWithFallback(
				invoice.contract_currency,
				invoice.invoice_currency,
				invoice.issue_date
			);

			const exchangeRate = exchangeRateResult.rate;
			const isFallback = exchangeRateResult.is_fallback;

			const amountInvoiceCurrency = Number(invoice.amount_contract_currency) * exchangeRate;

			await this.invoiceRepository.update(invoice.id, {
				amount_invoice_currency: amountInvoiceCurrency,
				fx_contract_to_invoice: exchangeRate,
			});

			for (const item of invoice.items) {
				await this.invoiceItemRepository.update(item.id, {
					unit_price_invoice_currency: Number(item.unit_price_contract_currency) * exchangeRate,
					subtotal_invoice_currency: Number(item.subtotal_contract_currency) * exchangeRate,
					tax_amount_invoice_currency: item.tax_amount_contract_currency ? Number(item.tax_amount_contract_currency) * exchangeRate : null,
					total_invoice_currency: Number(item.total_contract_currency) * exchangeRate,
					fx_contract_to_invoice: exchangeRate,
				});
			}

			if (isFallback) {
				this.logger.warn(
					`Tipo de cambio fallback usado para factura ${invoice.invoice_number}: ` +
						`${invoice.contract_currency}/${invoice.invoice_currency} = ${exchangeRate} ` +
						`(fecha: ${exchangeRateResult.rate_date})`
				);

				// Convertir issue_date a Date si es string
				const requestedDate = invoice.issue_date instanceof Date ? invoice.issue_date : new Date(invoice.issue_date);

				await this.invoiceNotificationService.sendExchangeRateFallbackNotification(invoice, {
					rate: exchangeRate,
					requestedDate,
					usedDate: exchangeRateResult.rate_date,
					fromCurrency: invoice.contract_currency,
					toCurrency: invoice.invoice_currency,
				});
			}

			this.logger.log(
				`✓ Montos calculados para factura ${invoice.invoice_number}: ` +
					`${invoice.contract_currency} ${invoice.amount_contract_currency} → ` +
					`${invoice.invoice_currency} ${amountInvoiceCurrency.toFixed(2)} (FX: ${exchangeRate})`
			);

			return {
				success: true,
				usedFallback: isFallback,
				exchangeRate,
				fallbackDate: isFallback ? exchangeRateResult.rate_date : undefined,
			};
		} catch (error) {
			this.logger.error(`No se pudo obtener tipo de cambio para factura ${invoice.invoice_number}: ${error.message}`);

			// Convertir issue_date a Date si es string
			const issueDate = invoice.issue_date instanceof Date ? invoice.issue_date : new Date(invoice.issue_date);

			await this.invoiceNotificationService.sendMissingExchangeRateNotification(
				invoice,
				issueDate,
				invoice.contract_currency,
				invoice.invoice_currency
			);

			const issueDateStr = issueDate instanceof Date ? issueDate.toISOString().split('T')[0] : String(issueDate);

			throw new Error(
				`No hay tipo de cambio disponible para ${invoice.contract_currency}/${invoice.invoice_currency} ` +
					`en fecha ${issueDateStr}. ` +
					`Se ha enviado notificación por correo electrónico.`
			);
		}
	}

	private async getInvoiceWithRelations(invoiceId: string): Promise<InvoiceWithRelations> {
		const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId } });

		const clientEntity = await this.clientEntityRepository.findOne({
			where: { id: invoice.client_entity_id },
		});

		const company = await this.companyRepository.findOne({
			where: { id: invoice.company_id },
		});

		const items = await this.invoiceItemRepository.find({
			where: { invoice_id: invoice.id },
		});

		(invoice as InvoiceWithRelations).clientEntity = clientEntity;
		(invoice as InvoiceWithRelations).company = company;
		(invoice as InvoiceWithRelations).items = items;

		return invoice as InvoiceWithRelations;
	}

	private mapCurrencyToOdooId(currency: string): number {
		const currencyMap: Record<string, number> = {
			USD: 2,
			CLP: 34,
			CLF: 158,
			MXN: 49,
			COP: 37,
			PEN: 135,
			EUR: 1,
		};

		return currencyMap[currency] || 2;
	}

	private mapTaxCodeToOdooIds(taxCode: string): number[] {
		if (!taxCode) {
			return [1];
		}

		const taxRate = parseFloat(taxCode);
		if (isNaN(taxRate)) {
			return [1];
		}

		if (taxRate === 19) {
			return [1];
		}

		return [1];
	}
}
