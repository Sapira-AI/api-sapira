import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';

import { CreateDraftInvoiceDTO, InvoiceLineItemDTO } from '../odoo/dtos/odoo.dto';
import { Company } from '../odoo/entities/companies.entity';
import { Product } from '../odoo/entities/products.entity';
import { OdooInvoicesService } from '../odoo/odoo-invoices.service';

import { InvoiceResultDto, ProcessInvoicesResponseDto, ProcessInvoicesSummaryDto } from './dtos/send-invoices.dto';
import { InvoiceItem } from './entities/invoice-item.entity';
import { Invoice } from './entities/invoice.entity';

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
		private readonly odooInvoicesService: OdooInvoicesService
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
					status: 'Enviada a Odoo',
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

		return {
			partner_id: invoice.clientEntity.odoo_partner_id,
			company_id: invoice.company.odoo_integration_id,
			move_type: 'out_invoice',
			invoice_date: invoice.issue_date?.toISOString().split('T')[0],
			invoice_date_due: invoice.due_date?.toISOString().split('T')[0],
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
