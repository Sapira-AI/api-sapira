import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';

import { ExchangeRatesService } from '../banco-central/services/exchange-rates.service';
import { CreateDraftInvoiceDTO, InvoiceLineItemDTO } from '../odoo/dtos/odoo.dto';
import { Company } from '../odoo/entities/companies.entity';
import { OdooProductMapping } from '../odoo/entities/odoo-product-mapping.entity';
import { Product } from '../odoo/entities/products.entity';
import { OdooInvoicesService } from '../odoo/odoo-invoices.service';

import { InvoiceResultDto, ProcessInvoicesResponseDto, ProcessInvoicesSummaryDto } from './dtos/send-invoices.dto';
import { Contract } from './entities/contract.entity';
import { InvoiceItem } from './entities/invoice-item.entity';
import { Invoice } from './entities/invoice.entity';
import { InvoiceNotificationService } from './invoice-notification.service';

interface InvoiceWithRelations extends Invoice {
	clientEntity?: ClientEntity;
	company?: Company;
	items?: InvoiceItem[];
	contract?: Contract;
}

interface ProcessOptions {
	dryRun: boolean;
	holdingId?: string;
	contractId?: string;
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
		@InjectRepository(OdooProductMapping)
		private readonly odooProductMappingRepository: Repository<OdooProductMapping>,
		@InjectRepository(Contract)
		private readonly contractRepository: Repository<Contract>,
		private readonly odooInvoicesService: OdooInvoicesService,
		private readonly invoiceNotificationService: InvoiceNotificationService,
		private readonly exchangeRatesService: ExchangeRatesService
	) {}

	async processInvoicesToSend(options: ProcessOptions): Promise<ProcessInvoicesResponseDto> {
		const { dryRun, holdingId, contractId } = options;
		const startTime = Date.now();

		this.logger.log(
			`🚀 Iniciando procesamiento de facturas - DryRun: ${dryRun}, HoldingId: ${holdingId || 'todos'}, ContractId: ${contractId || 'todos'}`
		);

		const results: InvoiceResultDto[] = [];
		const summary: ProcessInvoicesSummaryDto = {
			total: 0,
			sent: 0,
			errors: 0,
			skipped: 0,
		};

		try {
			const invoices = await this.getInvoicesToSend(holdingId, contractId);
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

	async getInvoicesToSend(holdingId?: string, contractId?: string): Promise<InvoiceWithRelations[]> {
		const query = this.invoiceRepository
			.createQueryBuilder('inv')
			.leftJoin('client_entities', 'cle', 'cle.id = inv.client_entity_id')
			.leftJoin('companies', 'com', 'com.id = inv.company_id')
			.leftJoin('contracts', 'con', 'con.id = inv.contract_id')
			.where('inv.status = :status', { status: 'Por Emitir' })
			.andWhere('inv.issue_date <= CURRENT_DATE')
			.andWhere('inv.sent_to_odoo_at IS NULL')
			.andWhere("DATE_TRUNC('month', inv.issue_date) = DATE_TRUNC('month', CURRENT_DATE)")
			.andWhere('cle.odoo_partner_id IS NOT NULL')
			.andWhere('com.odoo_integration_id IS NOT NULL')
			.andWhere('(con.auto_send_to_odoo = true OR con.auto_send_to_odoo IS NULL)')
			.orderBy('inv.issue_date', 'ASC')
			.addOrderBy('inv.created_at', 'ASC');

		if (holdingId) {
			query.andWhere('inv.holding_id = :holdingId', { holdingId });
		}

		if (contractId) {
			query.andWhere('inv.contract_id = :contractId', { contractId });
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

			const contract = await this.contractRepository.findOne({
				where: { id: invoice.contract_id },
			});

			(invoice as InvoiceWithRelations).clientEntity = clientEntity;
			(invoice as InvoiceWithRelations).company = company;
			(invoice as InvoiceWithRelations).items = items;
			(invoice as InvoiceWithRelations).contract = contract;
		}

		return invoices as InvoiceWithRelations[];
	}

	async sendInvoiceToOdoo(invoice: InvoiceWithRelations, dryRun: boolean): Promise<InvoiceResultDto> {
		// LOG INICIAL: Verificar relaciones al recibir la factura
		this.logger.log(`🔵 INICIO sendInvoiceToOdoo - Factura ${invoice.id}`);
		this.logger.log(`   clientEntity: ${invoice.clientEntity ? `SÍ (${invoice.clientEntity.legal_name})` : 'NO'}`);
		this.logger.log(`   company: ${invoice.company ? `SÍ (${invoice.company.legal_name})` : 'NO'}`);

		const result: InvoiceResultDto = {
			invoiceId: invoice.id,
			invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
			clientName: 'Sin cliente',
			companyName: 'Sin compañía',
			issueDate: invoice.issue_date,
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

			// Asignar nombres de cliente y compañía ANTES de mapear a Odoo (para que funcione en dryRun)
			this.logger.log(
				`📝 Asignando nombres - clientEntity: ${invoice.clientEntity ? 'existe' : 'NO EXISTE'}, company: ${invoice.company ? 'existe' : 'NO EXISTE'}`
			);

			if (invoice.clientEntity) {
				result.clientName =
					invoice.clientEntity.legal_name?.trim() ||
					invoice.clientEntity.tax_id?.trim() ||
					`Cliente ID: ${invoice.clientEntity.id.substring(0, 8)}`;
				this.logger.log(`   ✓ clientName asignado: ${result.clientName}`);
			} else {
				this.logger.warn(`   ✗ clientEntity es NULL - no se puede asignar nombre`);
			}

			if (invoice.company) {
				result.companyName =
					invoice.company.legal_name?.trim() ||
					invoice.company.holding_name?.trim() ||
					`Compañía ID: ${invoice.company.id.substring(0, 8)}`;
				this.logger.log(`   ✓ companyName asignado: ${result.companyName}`);
			} else {
				this.logger.warn(`   ✗ company es NULL - no se puede asignar nombre`);
			}

			const odooInvoiceData = await this.mapInvoiceToOdooFormat(invoice);

			// 🔍 VALIDAR TAXES ANTES DE ENVIAR
			const allTaxIds = odooInvoiceData.invoice_line_ids.flatMap((line) => line.tax_ids || []);
			const uniqueTaxIds = [...new Set(allTaxIds)];

			if (uniqueTaxIds.length > 0 && odooInvoiceData.company_id) {
				try {
					this.logger.log(`🔍 Validando ${uniqueTaxIds.length} taxes únicos para company_id ${odooInvoiceData.company_id}...`);

					const validation = await this.odooInvoicesService.validateTaxesForCompany(
						invoice.holding_id,
						odooInvoiceData.company_id,
						uniqueTaxIds
					);

					if (!validation.success) {
						const invalidTaxes = validation.tax_validations.filter((v) => !v.is_valid);
						const errorDetails = invalidTaxes
							.map((t) => `Tax ID ${t.tax_id} (${t.name}) pertenece a compañía ${t.company_id} (${t.company_name})`)
							.join(', ');

						result.status = 'error';
						result.error = `Taxes incompatibles con la compañía ${odooInvoiceData.company_id}`;
						result.details = `Los siguientes taxes no son válidos: ${errorDetails}`;

						this.logger.error(
							`❌ Factura ${invoice.invoice_number} tiene taxes incompatibles:\n` +
								`   Company ID solicitado: ${odooInvoiceData.company_id}\n` +
								`   Taxes inválidos: ${validation.invalid_tax_ids.join(', ')}\n` +
								`   Detalles: ${errorDetails}`
						);

						return result;
					}

					this.logger.log(`✅ Todos los taxes son válidos para company_id ${odooInvoiceData.company_id}`);
				} catch (validationError) {
					this.logger.warn(`⚠️ No se pudo validar taxes (continuando de todos modos): ${validationError.message}`);
				}
			}

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
					odoo_invoice_id: odooResponse.invoice_id,
					sent_to_odoo_at: new Date(),
				});

				result.status = 'sent';
				result.odooInvoiceId = odooResponse.invoice_id;

				// Si auto_invoice es true, emitir la factura automáticamente
				if (invoice.auto_invoice) {
					this.logger.log(`📝 Factura ${invoice.invoice_number} tiene auto_invoice=true, emitiendo automáticamente...`);

					try {
						const postResponse = await this.odooInvoicesService.postInvoice(invoice.holding_id, odooResponse.invoice_id);

						if (postResponse.success) {
							await this.invoiceRepository.update(invoice.id, {
								status: 'Emitida',
							});

							result.details = `Factura creada y emitida exitosamente en Odoo con ID: ${odooResponse.invoice_id} (estado: ${postResponse.state || 'posted'})`;
							this.logger.log(
								`✓ Factura ${invoice.invoice_number} creada y emitida exitosamente en Odoo (ID: ${odooResponse.invoice_id}, estado: ${postResponse.state || 'posted'})`
							);
						} else {
							result.details = `Factura creada en Odoo con ID: ${odooResponse.invoice_id}, pero falló la emisión: ${postResponse.message}`;
							this.logger.warn(`⚠️ Factura ${invoice.invoice_number} creada pero no se pudo emitir: ${postResponse.message}`);
						}
					} catch (postError) {
						result.details = `Factura creada en Odoo con ID: ${odooResponse.invoice_id}, pero falló la emisión: ${postError.message}`;
						this.logger.error(`✗ Error al emitir factura ${invoice.invoice_number}:`, postError);
					}
				} else {
					result.details = `Factura enviada exitosamente a Odoo con ID: ${odooResponse.invoice_id} (mantiene estado 'Por Emitir')`;
					this.logger.log(
						`✓ Factura ${invoice.invoice_number} enviada exitosamente a Odoo (ID: ${odooResponse.invoice_id}) - mantiene estado 'Por Emitir'`
					);
				}
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

		// Obtener tax_id por defecto de la compañía
		const companyDefaultTaxId = invoice.company?.odoo_default_sale_tax_id;
		const itemsToUpdate: Array<{ id: string; odoo_tax_id: number }> = [];

		this.logger.debug(
			`Factura ${invoice.invoice_number}: usando tax_id de compañía ${invoice.company?.legal_name} - ` +
				`odoo_default_sale_tax_id=${companyDefaultTaxId || 'no configurado, usando default [1]'}`
		);

		for (const item of invoice.items || []) {
			let odooProductId = 1;
			let taxId: number;

			// 1. Si el item ya tiene odoo_tax_id → usar ese (permite edición manual futura)
			if (item.odoo_tax_id) {
				taxId = item.odoo_tax_id;
				this.logger.debug(`Item ${item.id}: usando odoo_tax_id existente=${taxId} (configurado previamente)`);
			}
			// 2. Si no → usar tax de compañía y guardarlo
			else {
				taxId = companyDefaultTaxId || 1;
				itemsToUpdate.push({ id: item.id, odoo_tax_id: taxId });
				this.logger.debug(`Item ${item.id}: asignando tax_id de compañía=${taxId} (se guardará en BD)`);
			}

			if (item.product_id) {
				const mappingInfo = await this.getProductMappingInfo(item.product_id, invoice.holding_id);
				odooProductId = mappingInfo.odooProductId;

				this.logger.debug(
					`Item factura ${invoice.invoice_number}: producto_sapira=${item.product_id}, ` +
						`odoo_product=${odooProductId}, tax_id=${taxId}, source=${mappingInfo.source}`
				);
			}

			invoiceLines.push({
				product_id: odooProductId,
				name: item.description || 'Producto/Servicio',
				quantity: parseFloat(item.quantity?.toString() || '1'),
				price_unit: parseFloat(item.unit_price_invoice_currency?.toString() || '0'),
				discount: parseFloat(item.discount_pct?.toString() || '0'),
				tax_ids: [taxId],
			});
		}

		// Guardar odoo_tax_id en los items que no lo tenían
		if (itemsToUpdate.length > 0) {
			await this.updateInvoiceItemsTaxIds(itemsToUpdate);
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

		// Determinar auto_post basado en el campo auto_invoice de la factura
		const autoPost = invoice.auto_invoice ? 'at_date' : 'no';

		// Usar términos y condiciones del contrato si existen, sino usar notas de la factura
		const narration = invoice.contract?.invoice_terms_and_conditions || invoice.notes || undefined;

		this.logger.log(`📝 Narration para Odoo:`);
		this.logger.log(`   - contract.invoice_terms_and_conditions: ${invoice.contract?.invoice_terms_and_conditions ? 'SÍ' : 'NO'}`);
		this.logger.log(`   - invoice.notes: ${invoice.notes ? 'SÍ' : 'NO'}`);
		this.logger.log(`   - narration final: ${narration ? `"${narration.substring(0, 100)}..."` : 'UNDEFINED'}`);

		return {
			partner_id: invoice.clientEntity.odoo_partner_id,
			company_id: invoice.company.odoo_integration_id,
			move_type: 'out_invoice',
			invoice_date: issueDateStr,
			invoice_date_due: dueDateStr,
			payment_reference: invoice.invoice_number || undefined,
			invoice_origin: invoice.contract_id || undefined,
			narration: narration,
			x_sapira_invoice_id: invoice.id,
			currency_id: currencyId,
			auto_post: autoPost,
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

		this.logger.log(`🔍 Recargando factura ${invoiceId}`);
		this.logger.log(`   client_entity_id: ${invoice.client_entity_id}`);
		this.logger.log(`   company_id: ${invoice.company_id}`);

		const clientEntity = await this.clientEntityRepository.findOne({
			where: { id: invoice.client_entity_id },
		});

		const company = await this.companyRepository.findOne({
			where: { id: invoice.company_id },
		});

		this.logger.log(`   clientEntity encontrado: ${clientEntity ? 'SÍ' : 'NO'} - ${clientEntity?.legal_name || 'N/A'}`);
		this.logger.log(`   company encontrada: ${company ? 'SÍ' : 'NO'} - ${company?.legal_name || 'N/A'}`);

		const items = await this.invoiceItemRepository.find({
			where: { invoice_id: invoice.id },
		});

		const contract = await this.contractRepository.findOne({
			where: { id: invoice.contract_id },
		});

		this.logger.log(`   contract encontrado: ${contract ? 'SÍ' : 'NO'} - ID: ${contract?.id || 'N/A'}`);
		this.logger.log(
			`   contract.invoice_terms_and_conditions: ${contract?.invoice_terms_and_conditions ? `SÍ (${contract.invoice_terms_and_conditions.substring(0, 50)}...)` : 'NO/VACÍO'}`
		);

		(invoice as InvoiceWithRelations).clientEntity = clientEntity;
		(invoice as InvoiceWithRelations).company = company;
		(invoice as InvoiceWithRelations).items = items;
		(invoice as InvoiceWithRelations).contract = contract;

		return invoice as InvoiceWithRelations;
	}

	private async updateInvoiceItemsTaxIds(items: Array<{ id: string; odoo_tax_id: number }>): Promise<void> {
		try {
			for (const item of items) {
				await this.invoiceItemRepository.update({ id: item.id }, { odoo_tax_id: item.odoo_tax_id });
			}
			this.logger.debug(`✅ Actualizados ${items.length} items con odoo_tax_id`);
		} catch (error) {
			this.logger.error('❌ Error actualizando odoo_tax_id en invoice_items:', error);
		}
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

	private async getProductMappingInfo(
		sapiraProductId: string,
		holdingId: string
	): Promise<{
		odooProductId: number;
		source: 'mapping' | 'product_table' | 'default';
	}> {
		try {
			// 1. Buscar en odoo_product_mappings
			const mapping = await this.odooProductMappingRepository.findOne({
				where: {
					sapira_product_id: sapiraProductId,
					holding_id: holdingId,
				},
			});

			if (mapping) {
				this.logger.debug(`Producto ${sapiraProductId}: Usando mapeo - odoo_product_id=${mapping.odoo_product_id}`);
				return {
					odooProductId: mapping.odoo_product_id,
					source: 'mapping',
				};
			}

			// 2. Buscar en products.odoo_product_id
			const product = await this.productRepository.findOne({
				where: { id: sapiraProductId },
			});

			if (product?.odoo_product_id) {
				this.logger.debug(`Producto ${sapiraProductId}: Usando products.odoo_product_id=${product.odoo_product_id}`);
				return {
					odooProductId: product.odoo_product_id,
					source: 'product_table',
				};
			}

			// 3. Sin mapeo: usar default
			this.logger.warn(`Producto ${sapiraProductId}: Sin mapeo - usando default odoo_product_id=1`);
			return {
				odooProductId: 1,
				source: 'default',
			};
		} catch (error) {
			this.logger.error(`Error obteniendo mapeo de producto ${sapiraProductId}:`, error);
			return {
				odooProductId: 1,
				source: 'default',
			};
		}
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
