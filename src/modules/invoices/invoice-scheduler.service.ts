import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Model } from 'mongoose';
import { DataSource, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { ClientEntity } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { Contract } from '@/databases/postgresql/entities/contratos/contract.entity';
import { Product } from '@/databases/postgresql/entities/cotizaciones-catalogo/products.entity';
import { InvoiceItem } from '@/databases/postgresql/entities/facturacion/invoice-item.entity';
import { InvoiceReference } from '@/databases/postgresql/entities/facturacion/invoice-reference.entity';
import { Invoice } from '@/databases/postgresql/entities/facturacion/invoice.entity';
import { OdooProductMapping } from '@/databases/postgresql/entities/integraciones/odoo/odoo-product-mapping.entity';
import { pairKey, type PairLine, upperCode, valuateLinesByPair } from '@/modules/contracts/multicurrency';
import { INVOICE_ODOO_FAILURE_NOTIFICATION_TYPE, NotificationsService } from '@/modules/notifications/notifications.service';

import { ExchangeRatesService } from '../banco-central/services/exchange-rates.service';
import { CreateDraftInvoiceDTO, InvoiceLineItemDTO, OdooReferenceDTO } from '../odoo/dtos/odoo.dto';
import { OdooInvoicesService } from '../odoo/odoo-invoices.service';
import { DocumentTypeMappingService } from '../odoo/services/document-type-mapping.service';
import { TaxMappingService } from '../odoo/services/tax-mapping.service';

import { SchedulerJobProgressDto } from './dtos/scheduler-job.dto';
import { SchedulerReportQueryDto, SchedulerReportResponseDto } from './dtos/scheduler-report.dto';
import { InvoiceResultDto, ProcessInvoicesResponseDto, ProcessInvoicesSummaryDto } from './dtos/send-invoices.dto';
import { erpErrorSentence, translateErpError } from './erp-error-translation';
import { InvoiceNotificationService } from './invoice-notification.service';
import { InvoiceSchedulerGateway } from './invoice-scheduler.gateway';
import { type LastSendAttempt, lastSendAttemptOf } from './last-send-attempt';
import { InvoiceOdooSendLog, InvoiceOdooSendLogDocument } from './schemas/invoice-odoo-send-log.schema';
import { ExecutionEnvironment, ExecutionSource, InvoiceSchedulerJob, InvoiceSchedulerJobDocument } from './schemas/invoice-scheduler-job.schema';

interface InvoiceWithRelations extends Invoice {
	clientEntity?: ClientEntity;
	company?: Company;
	items?: InvoiceItem[];
	contract?: Contract;
	references?: InvoiceReference[];
}

/**
 * Notas de crédito / débito: las NC de v2 nacen con el estado de su factura (decisión 01-10; las previas nacieron Por Emitir) y el envío a
 * Odoo como `out_refund` todavía no existe (integración de Leon). Hasta entonces no salen por el envío automático ni por el manual (`docs/v2-rediseno/cambios-integracion-para-leon.md`).
 */
export const NON_SENDABLE_DOCUMENT_TYPES = ['NC', 'ND'] as const;

export const CREDIT_NOTE_SEND_PENDING = 'credit_note_send_pending';
/** Línea que viajaría al ERP sin producto de Odoo resoluble (mismo código que el bloqueo del 360 y de la cola de Facturación). */
export const PRODUCT_WITHOUT_ERP_MAPPING = 'product_without_erp_mapping';

export const isNonSendableDocumentType = (documentType: string | null | undefined): boolean =>
	(NON_SENDABLE_DOCUMENT_TYPES as readonly string[]).includes((documentType ?? '').trim().toUpperCase());

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
		@InjectRepository(InvoiceReference)
		private readonly invoiceReferenceRepository: Repository<InvoiceReference>,
		@InjectDataSource()
		private readonly dataSource: DataSource,
		@InjectModel(InvoiceOdooSendLog.name)
		private readonly invoiceOdooSendLogModel: Model<InvoiceOdooSendLogDocument>,
		@InjectModel(InvoiceSchedulerJob.name)
		private readonly invoiceSchedulerJobModel: Model<InvoiceSchedulerJobDocument>,
		private readonly odooInvoicesService: OdooInvoicesService,
		private readonly invoiceNotificationService: InvoiceNotificationService,
		private readonly exchangeRatesService: ExchangeRatesService,
		private readonly taxMappingService: TaxMappingService,
		private readonly documentTypeMappingService: DocumentTypeMappingService,
		private readonly schedulerGateway: InvoiceSchedulerGateway,
		private readonly notificationsService: NotificationsService
	) {}

	private getBusinessTimezone(): string {
		return process.env.TZ || 'America/Santiago';
	}

	private getExecutionEnvironment(): ExecutionEnvironment {
		const configuredEnvironment = process.env.NODE_ENV?.toLowerCase().trim();
		return configuredEnvironment === 'production' || configuredEnvironment === 'qa' ? configuredEnvironment : 'unknown';
	}

	private getBusinessTodayString(date: Date = new Date()): string {
		const formatter = new Intl.DateTimeFormat('en-CA', {
			timeZone: this.getBusinessTimezone(),
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		});

		const parts = formatter.formatToParts(date);
		const year = parts.find((part) => part.type === 'year')?.value;
		const month = parts.find((part) => part.type === 'month')?.value;
		const day = parts.find((part) => part.type === 'day')?.value;

		if (!year || !month || !day) {
			throw new Error('No se pudo determinar la fecha del negocio para el scheduler');
		}

		return `${year}-${month}-${day}`;
	}

	private normalizeCountryName(country?: string | null): string {
		if (!country) {
			return '';
		}

		return country
			.toLowerCase()
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '');
	}

	private usesChileanReferencePayload(country?: string | null): boolean {
		return this.normalizeCountryName(country) === 'chile';
	}

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
				const result = await this.sendInvoiceToOdoo(invoice, dryRun, 'automatic');
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
		const businessToday = this.getBusinessTodayString();
		const businessCurrentMonth = businessToday.substring(0, 7);

		const query = this.invoiceRepository
			.createQueryBuilder('inv')
			.leftJoin('client_entities', 'cle', 'cle.id = inv.client_entity_id')
			.leftJoin('companies', 'com', 'com.id = inv.company_id')
			.leftJoin('contracts', 'con', 'con.id = inv.contract_id')
			.where('inv.status = :status', { status: 'Por Emitir' })
			.andWhere('inv.issue_date <= :businessToday', { businessToday })
			.andWhere('inv.sent_to_odoo_at IS NULL')
			.andWhere('inv.is_active = true')
			.andWhere('(inv.document_type IS NULL OR inv.document_type NOT IN (:...nonSendableDocumentTypes))', {
				nonSendableDocumentTypes: [...NON_SENDABLE_DOCUMENT_TYPES],
			})
			.andWhere("TO_CHAR(inv.issue_date, 'YYYY-MM') = :businessCurrentMonth", { businessCurrentMonth })
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
			(invoice as InvoiceWithRelations).references = await this.invoiceReferenceRepository.find({
				where: { invoice_id: invoice.id },
				order: { created_at: 'ASC' },
			});
		}

		return invoices as InvoiceWithRelations[];
	}

	/**
	 * Envío puntual de UNA factura por id (Contrato 360 › "Enviar al ERP ahora", `contract-invoices.service.ts`): carga la factura con
	 * sus relaciones y reutiliza `sendInvoiceToOdoo`. No aplica la regla del mes en curso de `getInvoicesToSend`; los bloqueos de negocio
	 * los corre quien llama.
	 */
	async sendInvoiceById(invoiceId: string, dryRun: boolean, schedulerSource: 'manual' | 'automatic' = 'manual'): Promise<InvoiceResultDto> {
		const invoice = await this.getInvoiceWithRelations(invoiceId);

		if (isNonSendableDocumentType(invoice.document_type)) {
			throw new ConflictException({
				message:
					'El envío de notas de crédito y débito al ERP todavía no está disponible: se emitirán cuando exista la emisión de NC en Odoo',
				code: CREDIT_NOTE_SEND_PENDING,
				invoice_id: invoice.id,
				document_type: invoice.document_type,
			});
		}

		return await this.sendInvoiceToOdoo(invoice, dryRun, schedulerSource);
	}

	async sendInvoiceToOdoo(
		invoice: InvoiceWithRelations,
		dryRun: boolean,
		schedulerSource: 'manual' | 'automatic' = 'automatic'
	): Promise<InvoiceResultDto> {
		// LOG INICIAL: Verificar relaciones al recibir la factura
		this.logger.log(`🔵 INICIO sendInvoiceToOdoo - Factura ${invoice.id}`);
		this.logger.log(`   clientEntity: ${invoice.clientEntity ? `SÍ (${invoice.clientEntity.legal_name})` : 'NO'}`);
		this.logger.log(`   company: ${invoice.company ? `SÍ (${invoice.company.legal_name})` : 'NO'}`);
		this.logger.log(`   references: ${invoice.references ? `${invoice.references.length} cargadas` : 'NO CARGADAS'}`);

		const result: InvoiceResultDto = {
			invoiceId: invoice.id,
			holdingId: invoice.holding_id,
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

				// Registrar log de factura omitida
				result.errorType = 'validation';
				await this.createOdooSendLog({
					holdingId: invoice.holding_id,
					operation: 'create_draft',
					status: 'skipped',
					invoiceId: invoice.id,
					invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
					clientName: result.clientName,
					companyName: result.companyName,
					invoiceCurrency: invoice.invoice_currency,
					errorMessage: validation.error,
					errorType: 'validation',
					errorDetails: { validation_error: validation.error },
				});
				if (!dryRun) {
					await this.createOdooFailureNotification({
						invoice,
						stage: 'create_draft',
						title: `Factura ${invoice.invoice_number || 'SIN-NUMERO'} omitida por validación`,
						message: validation.error,
						errorType: 'validation',
						errorMessage: validation.error,
						schedulerSource,
					});
				}

				return result;
			}

			// NUEVO: Calcular montos si hay conversión de moneda (o, en multimoneda, si alguna línea convierte con su par: MM4)
			const convertsByPair = InvoiceSchedulerService.convertsByPair(invoice);

			if (invoice.contract_currency !== invoice.invoice_currency || convertsByPair) {
				try {
					await this.calculateInvoiceAmountsAtIssue(invoice);

					// Recargar invoice con valores actualizados
					invoice = await this.getInvoiceWithRelations(invoice.id);
				} catch (error) {
					result.status = 'skipped';
					result.error = error.message;
					result.details = 'No se pudo calcular tipo de cambio. Se ha enviado notificación por email.';
					this.logger.error(`✗ Factura ${invoice.invoice_number} omitida: ${error.message}`);

					// Registrar log de error en tipo de cambio
					result.errorType = 'exchange_rate';
					await this.createOdooSendLog({
						holdingId: invoice.holding_id,
						operation: 'create_draft',
						status: 'skipped',
						invoiceId: invoice.id,
						invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
						clientName: result.clientName,
						companyName: result.companyName,
						invoiceCurrency: invoice.invoice_currency,
						errorMessage: error.message,
						errorType: 'exchange_rate',
						errorDetails: { exchange_rate_error: error.message, stack: error.stack },
					});

					return result;
				}
			}

			// Validar que montos estén calculados
			if (!invoice.amount_invoice_currency && (invoice.contract_currency !== invoice.invoice_currency || convertsByPair)) {
				result.status = 'skipped';
				result.error = 'Montos no calculados en moneda de facturación';
				result.details = 'La factura requiere conversión de moneda pero los montos no están calculados';
				this.logger.error(`✗ Factura ${invoice.invoice_number} omitida: montos no calculados`);

				// Registrar log de montos no calculados
				result.errorType = 'amount_calculation';
				await this.createOdooSendLog({
					holdingId: invoice.holding_id,
					operation: 'create_draft',
					status: 'skipped',
					invoiceId: invoice.id,
					invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
					clientName: result.clientName,
					companyName: result.companyName,
					invoiceCurrency: invoice.invoice_currency,
					errorMessage: 'Montos no calculados en moneda de facturación',
					errorType: 'amount_calculation',
					errorDetails: {
						contract_currency: invoice.contract_currency,
						invoice_currency: invoice.invoice_currency,
						amount_invoice_currency: invoice.amount_invoice_currency,
					},
				});

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

			// Producto sin mapeo al ERP: antes viajaba en silencio como producto 1 de Odoo; ahora la factura se omite con error y aviso.
			const unmappedProducts = await this.findUnmappedProducts(invoice);

			if (unmappedProducts.length) {
				const errorMessage = `Productos sin mapeo a Odoo: ${unmappedProducts.join(', ')}`;

				result.status = 'skipped';
				result.error = errorMessage;
				result.details = 'La factura no se envía: mapea el producto en Integraciones › Odoo y vuelve a procesarla';
				this.logger.warn(`⚠️ Factura ${invoice.invoice_number || invoice.id} omitida: ${errorMessage}`);

				result.errorType = PRODUCT_WITHOUT_ERP_MAPPING;
				await this.createOdooSendLog({
					holdingId: invoice.holding_id,
					operation: 'create_draft',
					status: 'skipped',
					invoiceId: invoice.id,
					invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
					clientName: result.clientName,
					companyName: result.companyName,
					invoiceCurrency: invoice.invoice_currency,
					errorMessage,
					errorType: PRODUCT_WITHOUT_ERP_MAPPING,
					errorDetails: { unmapped_products: unmappedProducts },
				});

				if (!dryRun) {
					await this.createOdooFailureNotification({
						invoice,
						stage: 'product_mapping',
						title: `Factura ${invoice.invoice_number || 'SIN-NUMERO'} sin enviar: producto sin mapeo a Odoo`,
						message: `${errorMessage}. La factura no se envió al ERP.`,
						errorType: PRODUCT_WITHOUT_ERP_MAPPING,
						errorMessage,
						schedulerSource,
						errorDetails: { unmapped_products: unmappedProducts },
					});
				}

				return result;
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

						// Registrar log de error de taxes
						result.errorType = 'tax_validation';
						await this.createOdooSendLog({
							holdingId: invoice.holding_id,
							operation: 'create_draft',
							status: 'error',
							invoiceId: invoice.id,
							invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
							clientName: result.clientName,
							companyName: result.companyName,
							invoiceCurrency: invoice.invoice_currency,
							requestData: odooInvoiceData,
							errorMessage: result.error,
							errorType: 'tax_validation',
							errorDetails: {
								invalid_taxes: invalidTaxes,
								company_id: odooInvoiceData.company_id,
								tax_validations: validation.tax_validations,
							},
						});

						if (!dryRun) {
							await this.createOdooFailureNotification({
								invoice,
								stage: 'create_draft',
								title: `Taxes incompatibles en la factura ${invoice.invoice_number || 'SIN-NUMERO'}`,
								message: `${result.error}: ${result.details}`,
								errorType: 'tax_validation',
								errorMessage: `${result.error}: ${result.details}`,
								schedulerSource,
							});
						}

						return result;
					}

					this.logger.log(`✅ Todos los taxes son válidos para company_id ${odooInvoiceData.company_id}`);
				} catch (validationError) {
					this.logger.warn(`⚠️ No se pudo validar taxes (continuando de todos modos): ${validationError.message}`);
				}
			}

			if (dryRun) {
				const { invoiceData: finalOdooPayload } = await this.odooInvoicesService.buildDraftInvoicePayload(
					invoice.holding_id,
					odooInvoiceData
				);

				result.status = 'sent';
				result.details = `DRY RUN - Factura se enviaría a Odoo con partner_id: ${finalOdooPayload.partner_id} (payload final de account.move.create)`;
				this.logger.log(`🔍 DRY RUN - Factura ${invoice.invoice_number} (${invoice.id}) se enviaría a Odoo`);

				// Resumen de factura de exportación
				if (invoice.export_type === 1) {
					this.logger.log(`\n🌍 FACTURA DE EXPORTACIÓN - Items sin impuestos\n`);
				}

				// Resumen de descuentos
				const itemsWithDiscount = odooInvoiceData.invoice_line_ids.filter((line) => line.discount && line.discount > 0);
				if (itemsWithDiscount.length > 0) {
					this.logger.log(`\n💰 Resumen de descuentos:`);
					this.logger.log(`   - ${itemsWithDiscount.length} items con descuento`);
					itemsWithDiscount.forEach((line, index) => {
						this.logger.log(`   - Item ${index + 1}: ${line.name} - ${line.discount}%`);
					});
					console.log('');
				} else {
					this.logger.log(`\n💰 Sin descuentos en esta factura\n`);
				}

				console.log('📦 DATOS FINALES QUE SE ENVIARÍAN A ODOO:', JSON.stringify(finalOdooPayload, null, 2));
				return result;
			}

			this.logger.log(`📤 Enviando factura ${invoice.invoice_number} a Odoo...`);

			const startTime = Date.now();
			const odooResponse = await this.odooInvoicesService.createDraftInvoice(invoice.holding_id, odooInvoiceData);
			const durationMs = Date.now() - startTime;

			if (odooResponse.success && odooResponse.invoice_id) {
				await this.invoiceRepository.update(invoice.id, {
					odoo_invoice_id: odooResponse.invoice_id,
					sent_to_odoo_at: new Date(),
				});

				result.status = 'sent';
				result.odooInvoiceId = odooResponse.invoice_id;

				// Registrar log de envío exitoso
				await this.createOdooSendLog({
					holdingId: invoice.holding_id,
					operation: 'create_draft',
					status: 'success',
					invoiceId: invoice.id,
					invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
					odooInvoiceId: odooResponse.invoice_id,
					clientName: result.clientName,
					companyName: result.companyName,
					invoiceCurrency: invoice.invoice_currency,
					invoiceAmount: invoice.amount_invoice_currency,
					requestData: odooInvoiceData,
					responseData: odooResponse,
					durationMs,
				});

				// Si auto_invoice es true, emitir la factura automáticamente
				if (invoice.auto_invoice) {
					this.logger.log(`📝 Factura ${invoice.invoice_number} tiene auto_invoice=true, emitiendo automáticamente...`);

					try {
						const postStartTime = Date.now();
						const postResponse = await this.odooInvoicesService.postInvoice(invoice.holding_id, odooResponse.invoice_id);
						const postDurationMs = Date.now() - postStartTime;

						if (postResponse.success) {
							// Registrar log de post exitoso
							await this.createOdooSendLog({
								holdingId: invoice.holding_id,
								operation: 'post_invoice',
								status: 'success',
								invoiceId: invoice.id,
								invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
								odooInvoiceId: odooResponse.invoice_id,
								clientName: result.clientName,
								companyName: result.companyName,
								invoiceCurrency: invoice.invoice_currency,
								requestData: { odoo_invoice_id: odooResponse.invoice_id },
								responseData: postResponse,
								durationMs: postDurationMs,
							});

							// Paso adicional: Emisión electrónica según país
							try {
								const emitStartTime = Date.now();
								const emitResponse = await this.odooInvoicesService.emitElectronicInvoice(
									invoice.holding_id,
									odooResponse.invoice_id,
									invoice.company.country
								);
								const emitDurationMs = Date.now() - emitStartTime;

								// Actualizar estado según resultado de emisión electrónica
								if (emitResponse.success) {
									if (emitResponse.electronic_status === 'accepted') {
										await this.invoiceRepository.update(invoice.id, {
											status: 'Emitida',
										});
										result.details = `Factura creada y emitida electrónicamente en Odoo (ID: ${odooResponse.invoice_id}, país: ${invoice.company.country}, estado: ${emitResponse.electronic_status})`;
										this.logger.log(
											`✓ Factura ${invoice.invoice_number} emitida electrónicamente exitosamente (${invoice.company.country})`
										);
									} else if (emitResponse.electronic_status === 'rejected') {
										const electronicErrorMessage =
											emitResponse.electronic_errors?.map((e) => e.message).join(', ') ||
											'La entidad electrónica rechazó la factura';

										await this.invoiceRepository.update(invoice.id, {
											status: 'Emitida',
										});
										result.status = 'error';
										result.error = electronicErrorMessage;
										result.details = `Factura publicada en Odoo pero rechazada por entidad electrónica (${invoice.company.country}): ${electronicErrorMessage}`;
										this.logger.error(
											`✗ Factura ${invoice.invoice_number} rechazada por entidad electrónica: ${electronicErrorMessage}`
										);
									} else if (emitResponse.electronic_status === 'not_required') {
										await this.invoiceRepository.update(invoice.id, {
											status: 'Emitida',
										});
										result.details = `Factura creada y emitida exitosamente en Odoo (ID: ${odooResponse.invoice_id}, país: ${invoice.company.country})`;
										this.logger.log(`✓ Factura ${invoice.invoice_number} emitida exitosamente (${invoice.company.country})`);
									} else {
										// Estado 'sent' - enviada pero pendiente de confirmación
										await this.invoiceRepository.update(invoice.id, {
											status: 'Emitida',
										});
										result.details = `Factura enviada a entidad electrónica (${invoice.company.country}), pendiente de confirmación`;
										this.logger.log(
											`⏳ Factura ${invoice.invoice_number} enviada a entidad electrónica, pendiente de confirmación`
										);
									}

									// Registrar log de emisión electrónica
									await this.createOdooSendLog({
										holdingId: invoice.holding_id,
										operation: 'emit_electronic_invoice',
										status: emitResponse.electronic_status === 'rejected' ? 'error' : 'success',
										invoiceId: invoice.id,
										invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
										odooInvoiceId: odooResponse.invoice_id,
										clientName: result.clientName,
										companyName: result.companyName,
										invoiceCurrency: invoice.invoice_currency,
										requestData: {
											odoo_invoice_id: odooResponse.invoice_id,
											country: invoice.company.country,
										},
										responseData: emitResponse,
										errorMessage:
											emitResponse.electronic_status === 'rejected'
												? emitResponse.electronic_errors?.map((e) => e.message).join(', ')
												: undefined,
										errorType: emitResponse.electronic_status === 'rejected' ? 'electronic_rejection' : undefined,
										durationMs: emitDurationMs,
									});

									if (emitResponse.electronic_status === 'rejected') {
										await this.createOdooFailureNotification({
											invoice,
											stage: 'emit_electronic_invoice',
											title: `Error en emision electronica de factura ${invoice.invoice_number || 'SIN-NUMERO'}`,
											message: result.details || result.error || 'La factura fue rechazada por la entidad electrónica',
											errorType: 'electronic_rejection',
											errorMessage:
												emitResponse.electronic_errors?.map((e) => e.message).join(', ') ||
												'La entidad electrónica rechazó la factura',
											odooInvoiceId: odooResponse.invoice_id,
											schedulerSource,
											responseData: emitResponse,
										});
									} else {
										try {
											const customerSendStartTime = Date.now();
											const customerSendResponse = await this.odooInvoicesService.sendInvoiceToCustomer(
												invoice.holding_id,
												odooResponse.invoice_id
											);
											const customerSendDurationMs = Date.now() - customerSendStartTime;

											result.details = `${result.details}. ${customerSendResponse.message}`;
											await this.createOdooSendLog({
												holdingId: invoice.holding_id,
												operation: 'send_invoice_to_customer',
												status: 'success',
												invoiceId: invoice.id,
												invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
												odooInvoiceId: odooResponse.invoice_id,
												clientName: result.clientName,
												companyName: result.companyName,
												invoiceCurrency: invoice.invoice_currency,
												requestData: { odoo_invoice_id: odooResponse.invoice_id },
												responseData: customerSendResponse,
												durationMs: customerSendDurationMs,
											});
										} catch (customerSendError) {
											const customerSendErrorDetails = customerSendError as Error;
											result.status = 'error';
											result.error = customerSendErrorDetails.message;
											result.details = `Factura emitida en Odoo (ID: ${odooResponse.invoice_id}) pero no se pudo enviar al cliente: ${customerSendErrorDetails.message}`;

											result.errorType = 'customer_email_delivery';
											await this.createOdooSendLog({
												holdingId: invoice.holding_id,
												operation: 'send_invoice_to_customer',
												status: 'error',
												invoiceId: invoice.id,
												invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
												odooInvoiceId: odooResponse.invoice_id,
												clientName: result.clientName,
												companyName: result.companyName,
												invoiceCurrency: invoice.invoice_currency,
												requestData: { odoo_invoice_id: odooResponse.invoice_id },
												errorMessage: customerSendErrorDetails.message,
												errorType: 'customer_email_delivery',
												errorDetails: { stack: customerSendErrorDetails.stack },
											});

											await this.createOdooFailureNotification({
												invoice,
												stage: 'send_invoice_to_customer',
												title: `Error enviando factura ${invoice.invoice_number || 'SIN-NUMERO'} al cliente`,
												message: result.details,
												errorType: 'customer_email_delivery',
												errorMessage: customerSendErrorDetails.message,
												odooInvoiceId: odooResponse.invoice_id,
												schedulerSource,
												errorDetails: { stack: customerSendErrorDetails.stack },
											});
										}
									}
								}
							} catch (emitError) {
								// Error en emisión electrónica, pero la factura está publicada en Odoo
								this.logger.error(`✗ Error en emisión electrónica para ${invoice.invoice_number}:`, emitError);

								await this.invoiceRepository.update(invoice.id, {
									status: 'Emitida',
								});

								result.status = 'error';
								result.error = emitError.message;
								result.details = `Factura publicada en Odoo (ID: ${odooResponse.invoice_id}) pero falló emisión electrónica: ${emitError.message}`;

								// Registrar log de error en emisión electrónica
								result.errorType = 'emit_electronic_exception';
								await this.createOdooSendLog({
									holdingId: invoice.holding_id,
									operation: 'emit_electronic_invoice',
									status: 'error',
									invoiceId: invoice.id,
									invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
									odooInvoiceId: odooResponse.invoice_id,
									clientName: result.clientName,
									companyName: result.companyName,
									invoiceCurrency: invoice.invoice_currency,
									requestData: {
										odoo_invoice_id: odooResponse.invoice_id,
										country: invoice.company.country,
									},
									errorMessage: emitError.message,
									errorType: 'emit_electronic_exception',
									errorDetails: { stack: emitError.stack },
								});

								await this.createOdooFailureNotification({
									invoice,
									stage: 'emit_electronic_invoice',
									title: `Error en emision electronica de factura ${invoice.invoice_number || 'SIN-NUMERO'}`,
									message: result.details,
									errorType: 'emit_electronic_exception',
									errorMessage: emitError.message,
									odooInvoiceId: odooResponse.invoice_id,
									schedulerSource,
									errorDetails: { stack: emitError.stack },
								});
							}
						} else {
							result.status = 'error';
							result.error = postResponse.message || 'Falló el post de la factura en Odoo';
							result.details = `Factura creada en Odoo con ID: ${odooResponse.invoice_id}, pero falló la emisión: ${postResponse.message}`;
							this.logger.warn(`⚠️ Factura ${invoice.invoice_number} creada pero no se pudo emitir: ${postResponse.message}`);

							// Registrar log de error en emisión
							result.errorType = 'odoo_post_failed';
							await this.createOdooSendLog({
								holdingId: invoice.holding_id,
								operation: 'post_invoice',
								status: 'error',
								invoiceId: invoice.id,
								invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
								odooInvoiceId: odooResponse.invoice_id,
								clientName: result.clientName,
								companyName: result.companyName,
								invoiceCurrency: invoice.invoice_currency,
								requestData: { odoo_invoice_id: odooResponse.invoice_id },
								responseData: postResponse,
								errorMessage: postResponse.message,
								errorType: 'odoo_post_failed',
								durationMs: postDurationMs,
							});

							await this.createOdooFailureNotification({
								invoice,
								stage: 'post_invoice',
								title: `Error al publicar factura ${invoice.invoice_number || 'SIN-NUMERO'} en Odoo`,
								message: result.details,
								errorType: 'odoo_post_failed',
								errorMessage: postResponse.message || 'Falló el post de la factura en Odoo',
								odooInvoiceId: odooResponse.invoice_id,
								schedulerSource,
								responseData: postResponse,
							});
						}
					} catch (postError) {
						result.status = 'error';
						result.error = postError.message;
						result.details = `Factura creada en Odoo con ID: ${odooResponse.invoice_id}, pero falló la emisión: ${postError.message}`;
						this.logger.error(`✗ Error al emitir factura ${invoice.invoice_number}:`, postError);

						// Registrar log de excepción en emisión
						result.errorType = 'odoo_post_exception';
						await this.createOdooSendLog({
							holdingId: invoice.holding_id,
							operation: 'post_invoice',
							status: 'error',
							invoiceId: invoice.id,
							invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
							odooInvoiceId: odooResponse.invoice_id,
							clientName: result.clientName,
							companyName: result.companyName,
							invoiceCurrency: invoice.invoice_currency,
							requestData: { odoo_invoice_id: odooResponse.invoice_id },
							errorMessage: postError.message,
							errorType: 'odoo_post_exception',
							errorDetails: { stack: postError.stack },
						});

						await this.createOdooFailureNotification({
							invoice,
							stage: 'post_invoice',
							title: `Error al publicar factura ${invoice.invoice_number || 'SIN-NUMERO'} en Odoo`,
							message: result.details,
							errorType: 'odoo_post_exception',
							errorMessage: postError.message,
							odooInvoiceId: odooResponse.invoice_id,
							schedulerSource,
							errorDetails: { stack: postError.stack },
						});
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

				// Registrar log de error al crear factura
				result.errorType = 'odoo_rejection';
				await this.createOdooSendLog({
					holdingId: invoice.holding_id,
					operation: 'create_draft',
					status: 'error',
					invoiceId: invoice.id,
					invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
					clientName: result.clientName,
					companyName: result.companyName,
					invoiceCurrency: invoice.invoice_currency,
					requestData: odooInvoiceData,
					responseData: odooResponse,
					errorMessage: result.error,
					errorType: 'odoo_rejection',
					durationMs,
				});
				await this.createOdooFailureNotification({
					invoice,
					stage: 'create_draft',
					title: `Error al crear la factura ${invoice.invoice_number || 'SIN-NUMERO'} en Odoo`,
					message: result.error,
					errorType: 'odoo_rejection',
					errorMessage: result.error,
					schedulerSource,
					responseData: odooResponse,
				});
			}
		} catch (error) {
			result.status = 'error';
			result.error = error.message || 'Error inesperado';
			this.logger.error(`✗ Excepción al procesar factura ${invoice.invoice_number}:`, error);

			// Registrar log de excepción general
			result.errorType = 'unexpected_exception';
			await this.createOdooSendLog({
				holdingId: invoice.holding_id,
				operation: 'create_draft',
				status: 'error',
				invoiceId: invoice.id,
				invoiceNumber: invoice.invoice_number || 'SIN-NUMERO',
				clientName: result.clientName,
				companyName: result.companyName,
				invoiceCurrency: invoice.invoice_currency,
				errorMessage: error.message || 'Error inesperado',
				errorType: 'unexpected_exception',
				errorDetails: {
					stack: error.stack,
					error_type: error.constructor.name,
				},
			});
			if (!dryRun) {
				await this.createOdooFailureNotification({
					invoice,
					stage: 'create_draft',
					title: `Excepción al enviar la factura ${invoice.invoice_number || 'SIN-NUMERO'} a Odoo`,
					message: result.error,
					errorType: 'unexpected_exception',
					errorMessage: result.error,
					schedulerSource,
					errorDetails: { stack: error.stack },
				});
			}
		}

		// Notificaciones v2: la factura llegó al ERP → se cierran sus avisos de falla abiertos (todas las etapas y errores).
		if (!dryRun && result.status === 'sent') {
			await this.resolveOdooFailureNotifications(invoice);
		}

		return result;
	}

	/** Cierre automático de `invoice_odoo_failure` de una factura enviada bien. Un fallo aquí no afecta el envío. */
	private async resolveOdooFailureNotifications(invoice: InvoiceWithRelations): Promise<void> {
		try {
			await this.notificationsService.resolveOpen(invoice.holding_id, { type: INVOICE_ODOO_FAILURE_NOTIFICATION_TYPE, resourceId: invoice.id });
			await this.invoiceNotificationService.resolveMissingExchangeRate(invoice.holding_id, invoice.id);
		} catch (error) {
			this.logger.warn(`No se pudieron cerrar los avisos de envío de la factura ${invoice.id}: ${(error as Error).message}`);
		}
	}

	async mapInvoiceToOdooFormat(invoice: InvoiceWithRelations): Promise<CreateDraftInvoiceDTO> {
		const invoiceLines: InvoiceLineItemDTO[] = [];
		const companyId = invoice.company?.odoo_integration_id;
		const isExportInvoice = invoice.export_type === 1;

		this.logger.log(
			`📎 Estado de referencias antes de mapear factura ${invoice.invoice_number}: ${
				invoice.references ? `${invoice.references.length} cargadas` : 'NO CARGADAS'
			}`
		);

		// Log de factura de exportación
		if (isExportInvoice) {
			this.logger.log(`🌍 FACTURA DE EXPORTACIÓN - Los items se enviarán SIN impuestos`);
		}

		// Log de posición fiscal del cliente
		if (invoice.clientEntity?.odoo_fiscal_position_id) {
			this.logger.log(
				`✅ Cliente ${invoice.clientEntity.legal_name} tiene posición fiscal: ` +
					`"${invoice.clientEntity.odoo_fiscal_position_name}" (ID: ${invoice.clientEntity.odoo_fiscal_position_id})`
			);
		} else {
			this.logger.debug(`ℹ️  Cliente ${invoice.clientEntity?.legal_name || 'N/A'} no tiene posición fiscal configurada`);
		}

		const normalizedCountry = this.normalizeCountryName(invoice.company?.country);

		/**
		 * Líneas en cero (Contratos v2, Facturas en el 360 · etapa 4 — cambio puntual de Domi/Claude, avisado a Leon): una línea con
		 * cantidad 0 (consumo informado en cero o línea dejada en cero al editar) se conserva en Sapira para trazabilidad, pero NO viaja al
		 * ERP ni aparece en el documento. Solo se omiten si la factura tiene al menos una línea con cantidad distinta de cero: una factura
		 * con todas sus líneas en cero se envía igual que antes (v2 no las deja Por Emitir: pasan a Cancelada "sin cobro").
		 */
		/**
		 * Líneas internas (Contratos v2 · etapa 6, facturación parcial por OC): las líneas con `visible_line_id` son la asignación interna por
		 * ítem y período de una única línea visible del documento; solo la visible viaja al ERP. También cambio puntual avisado a Leon
		 * (`docs/v2-rediseno/cambios-integracion-para-leon.md`).
		 */
		const allItems = invoice.items || [];
		const itemsToSend = InvoiceSchedulerService.itemsSentToErp(invoice);

		if (itemsToSend.length < allItems.length) {
			this.logger.log(
				`🧹 Factura ${invoice.invoice_number || invoice.id}: ${allItems.length - itemsToSend.length} línea(s) no se envían al ERP (en cero o internas de una línea visible)`
			);
		}

		for (const item of itemsToSend) {
			let odooProductId = 1;
			const itemLabel = item.description || 'Producto/Servicio';
			this.logger.log(`🧾 Iniciando cálculo de impuestos para item ${item.id} (${itemLabel})`);
			this.logger.log(
				`   - invoice_id: ${invoice.id}\n` +
					`   - invoice_number: ${invoice.invoice_number || 'SIN-NUMERO'}\n` +
					`   - company_odoo_id: ${companyId}\n` +
					`   - export_type: ${invoice.export_type}\n` +
					`   - sapira_product_id: ${item.product_id || 'SIN PRODUCTO'}\n` +
					`   - client_fiscal_position_id: ${invoice.clientEntity?.odoo_fiscal_position_id || 'SIN POSICION FISCAL'}`
			);

			// Obtener mapeo del producto. Sin mapeo NO se envía el producto 1 (Contratos v2, cambio puntual avisado a Leon):
			// `sendInvoiceToOdoo` ya rechazó la factura con `product_without_erp_mapping`; esto es la defensa si se llama directo.
			if (item.product_id) {
				const mappingInfo = await this.getProductMappingInfo(item.product_id, invoice.holding_id);

				if (mappingInfo.odooProductId === null) {
					throw new Error(`${PRODUCT_WITHOUT_ERP_MAPPING}: el producto ${item.product_id} no está mapeado a un producto de Odoo`);
				}
				odooProductId = mappingInfo.odooProductId;

				this.logger.debug(
					`Item factura ${invoice.invoice_number}: producto_sapira=${item.product_id}, ` +
						`odoo_product=${odooProductId}, source=${mappingInfo.source}`
				);
				this.logger.log(`   - mapeo producto: sapira=${item.product_id} -> odoo=${odooProductId} (source=${mappingInfo.source})`);
			} else {
				this.logger.warn(`⚠️ Item ${item.id} no tiene product_id, se usará odoo_product_id por defecto=${odooProductId}`);
			}

			let finalTaxIds: number[] = [];

			// Verificar si es factura de exportación
			if (isExportInvoice) {
				if (normalizedCountry === 'mexico') {
					this.logger.log(`🌍🇲🇽 Factura de exportación MX - buscando impuesto de venta 0% para item ${item.id}`);
					const zeroRateTaxId = await this.taxMappingService.getCompanyZeroRateSaleTax(companyId, invoice.holding_id);
					if (zeroRateTaxId !== null) {
						finalTaxIds = [zeroRateTaxId];
						this.logger.log(`🌍🇲🇽 Factura de exportación MX - Item con impuesto 0%: ${itemLabel} -> tax_id ${zeroRateTaxId}`);
					} else {
						finalTaxIds = [];
						this.logger.warn(
							`⚠️ Factura de exportación MX sin impuesto 0% configurado para compañía ${companyId}. Se enviará sin impuestos para item ${item.id}`
						);
					}
				} else {
					// Facturas de exportación NO llevan impuestos
					finalTaxIds = [];
					this.logger.log(`🌍 Factura de exportación - Item sin impuestos: ${item.description || 'Producto/Servicio'}`);
				}
			} else {
				// Flujo normal: obtener impuestos de venta del producto
				this.logger.log(`🔎 Paso 1/2 item ${item.id}: consultando impuestos base del producto ${odooProductId} para company_id ${companyId}`);
				const productSaleTaxIds = await this.taxMappingService.getProductSaleTaxes(odooProductId, companyId, invoice.holding_id);
				this.logger.log(`   - impuestos base producto ${odooProductId}: [${productSaleTaxIds.join(', ')}]`);

				// Aplicar mapeo de posición fiscal si el cliente tiene una configurada
				if (invoice.clientEntity?.odoo_fiscal_position_id) {
					this.logger.log(
						`🔎 Paso 2/2 item ${item.id}: aplicando posición fiscal ${invoice.clientEntity.odoo_fiscal_position_id} a impuestos [${productSaleTaxIds.join(', ')}]`
					);
					const mappingResult = await this.taxMappingService.applyFiscalPositionMapping(
						productSaleTaxIds,
						invoice.clientEntity.odoo_fiscal_position_id,
						invoice.holding_id
					);
					finalTaxIds = mappingResult.final_tax_ids;

					this.logger.debug(
						`📦 Producto ${odooProductId}: ${productSaleTaxIds.length} impuestos originales → ` +
							`${finalTaxIds.length} impuestos finales (con mapeo de posición fiscal)`
					);
					this.logger.log(
						`   - resultado mapeo posición fiscal: ${mappingResult.mappings_applied.length > 0 ? JSON.stringify(mappingResult.mappings_applied) : 'sin acciones explícitas'}`
					);
				} else {
					// Sin posición fiscal, usar impuestos del producto directamente
					finalTaxIds = productSaleTaxIds;
					this.logger.debug(`📦 Producto ${odooProductId}: ${finalTaxIds.length} impuestos (sin posición fiscal)`);
					this.logger.log(`   - sin posición fiscal, se conservan impuestos base: [${finalTaxIds.join(', ')}]`);
				}

				this.logger.debug(`Item ${item.id}: tax_ids finales = [${finalTaxIds.join(', ')}]`);
			}

			this.logger.log(`✅ Item ${item.id}: tax_ids finales resueltos = [${finalTaxIds.join(', ')}]`);

			const discount = parseFloat(item.discount_pct?.toString() || '0');
			const quantity = parseFloat(item.quantity?.toString() || '1');
			const priceUnit = parseFloat(item.unit_price_invoice_currency?.toString() || '0');

			// Log detallado del item incluyendo descuento
			const discountInfo = discount > 0 ? ` - Descuento: ${discount}%` : '';
			this.logger.log(`📦 Item: ${item.description || 'Producto/Servicio'} - Precio: ${priceUnit} - Cantidad: ${quantity}${discountInfo}`);

			invoiceLines.push({
				product_id: odooProductId,
				name: item.description || 'Producto/Servicio',
				quantity,
				price_unit: priceUnit,
				discount,
				tax_ids: finalTaxIds,
			});
		}

		// Log resumen
		if (isExportInvoice) {
			if (normalizedCountry === 'mexico') {
				this.logger.log(
					`✅ Factura ${invoice.invoice_number}: ${invoiceLines.length} items procesados (EXPORTACIÓN MX - con impuesto 0% cuando exista)`
				);
			} else {
				this.logger.log(`✅ Factura ${invoice.invoice_number}: ${invoiceLines.length} items procesados (EXPORTACIÓN - sin impuestos)`);
			}
		} else {
			this.logger.log(`✅ Factura ${invoice.invoice_number}: ${invoiceLines.length} items procesados con mapeo de impuestos`);
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

		this.logger.log(`📋 Invoice Origin para Odoo:`);
		this.logger.log(`   - contract.contract_number: ${invoice.contract?.contract_number || 'NO DEFINIDO'}`);
		this.logger.log(`   - invoice_origin final: ${invoice.contract?.contract_number || 'UNDEFINED'}`);

		// Determinar si requiere detracción (Perú >= 700 PEN)
		let l10nPeEdiOperationType: string | undefined = undefined;

		if (normalizedCountry === 'peru') {
			const invoiceAmount = parseFloat(invoice.amount_invoice_currency?.toString() || '0');
			let requiresDetraction = false;

			if (invoice.invoice_currency === 'PEN') {
				// Factura en soles: comparar directamente
				requiresDetraction = invoiceAmount >= 700;
				this.logger.log(`🇵🇪 Perú - Factura en PEN: ${invoiceAmount} >= 700? ${requiresDetraction}`);
			} else if (invoice.invoice_currency === 'USD') {
				// Factura en dólares: convertir 700 PEN a USD
				try {
					const exchangeRateData = await this.exchangeRatesService.getExchangeRateWithFallback('USD', 'PEN', invoice.issue_date);

					if (exchangeRateData && exchangeRateData.rate) {
						// 700 PEN / rate = equivalente en USD
						const threshold = 700 / exchangeRateData.rate;
						requiresDetraction = invoiceAmount >= threshold;

						this.logger.log(
							`🇵🇪 Perú - Factura en USD: ${invoiceAmount} >= ${threshold.toFixed(2)} (700 PEN / ${exchangeRateData.rate})? ${requiresDetraction}`
						);
					} else {
						this.logger.warn(`⚠️ No se pudo obtener tipo de cambio USD/PEN para ${invoice.issue_date}`);
					}
				} catch (error) {
					this.logger.error(`❌ Error al obtener tipo de cambio USD/PEN: ${error.message}`);
				}
			} else {
				// Otras monedas: no aplicar detracción por ahora
				this.logger.log(`🇵🇪 Perú - Moneda ${invoice.invoice_currency} no soportada para detracción`);
			}

			if (requiresDetraction) {
				l10nPeEdiOperationType = '1001';
				this.logger.log(`✅ Factura sujeta a detracción - l10n_pe_edi_operation_type: "1001"`);
			}
		}

		// Mapear referencias si existen
		let odooRef: string | undefined = undefined;
		let l10nClReferenceIds: OdooReferenceDTO[] | undefined = undefined;

		if (invoice.references && invoice.references.length > 0 && this.usesChileanReferencePayload(invoice.company?.country)) {
			this.logger.log(`📎 Procesando ${invoice.references.length} referencias para factura ${invoice.invoice_number}`);

			const referencesPromises = invoice.references.map(async (ref) => {
				const odooDocTypeId = await this.getOdooDocumentTypeId(invoice.holding_id, ref.document_type_code, invoice.company?.country);

				if (!odooDocTypeId) {
					this.logger.warn(
						`⚠️ Referencia omitida: documento "${ref.document_number}" ` + `con tipo "${ref.document_type_code}" no encontrado en Odoo`
					);
					return null;
				}

				const refDateStr = ref.reference_date
					? ref.reference_date instanceof Date
						? ref.reference_date.toISOString().split('T')[0]
						: String(ref.reference_date).split('T')[0]
					: undefined;

				this.logger.log(`  ✓ Referencia: ${ref.document_number} (tipo: ${ref.document_type_code} → Odoo ID: ${odooDocTypeId})`);

				return {
					origin_doc_number: ref.document_number,
					l10n_cl_reference_doc_type_id: odooDocTypeId,
					reference_doc_code: ref.reference_code || (false as const),
					reason: ref.reason || (false as const),
					date: refDateStr,
					l10n_cl_reference_doc_internal_type: false as const,
				} as OdooReferenceDTO;
			});

			const mappedReferences = await Promise.all(referencesPromises);
			l10nClReferenceIds = mappedReferences.filter((ref): ref is OdooReferenceDTO => ref !== null);

			if (l10nClReferenceIds.length === 0) {
				l10nClReferenceIds = undefined;
				this.logger.warn(`⚠️ Ninguna referencia pudo ser mapeada para factura ${invoice.invoice_number}`);
			} else {
				this.logger.log(`✅ ${l10nClReferenceIds.length} referencias mapeadas correctamente`);
			}
		} else if (invoice.references && invoice.references.length > 0) {
			odooRef = invoice.references.find((reference) => reference.document_number?.trim())?.document_number?.trim();

			this.logger.log(
				`ℹ️ Referencias detectadas para factura ${invoice.invoice_number}, pero no se enviarán en l10n_cl_reference_ids porque la compañía es ${invoice.company?.country || 'desconocida'}`
			);

			if (odooRef) {
				this.logger.log(`🧾 Referencia no chilena enviada en ref: ${odooRef}`);
			}
		}

		// Obtener tipo de documento latinoamericano
		this.logger.log(`🔍 Consultando tipo de documento LATAM para compañía ${invoice.company.odoo_integration_id}...`);
		let l10nLatamDocumentTypeId: number | undefined = undefined;
		try {
			const docType = await this.documentTypeMappingService.getDefaultDocumentTypeForInvoice(
				invoice.holding_id,
				invoice.company.odoo_integration_id,
				'out_invoice'
			);

			if (docType) {
				l10nLatamDocumentTypeId = docType.id;
				this.logger.log(`📄 Tipo de documento LATAM: ID=${docType.id}, Código="${docType.code}", Nombre="${docType.name}"`);
			} else {
				this.logger.log(`ℹ️ No se requiere tipo de documento LATAM para esta compañía`);
			}
		} catch (error) {
			this.logger.warn(`⚠️ Error obteniendo tipo de documento LATAM: ${error.message}`);
		}

		return {
			partner_id: invoice.clientEntity.odoo_partner_id,
			company_id: invoice.company.odoo_integration_id,
			move_type: 'out_invoice',
			ref: odooRef,
			invoice_date: issueDateStr,
			invoice_date_due: dueDateStr,
			payment_reference: invoice.invoice_number || undefined,
			invoice_origin: invoice.contract?.contract_number || undefined,
			narration: narration,
			x_sapira_invoice_id: invoice.id,
			currency_id: currencyId,
			auto_post: autoPost,
			invoice_line_ids: invoiceLines,
			l10n_latam_document_type_id: l10nLatamDocumentTypeId,
			l10n_pe_edi_operation_type: l10nPeEdiOperationType,
			l10n_cl_reference_ids: l10nClReferenceIds,
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

		if (this.usesChileanReferencePayload(invoice.company?.country) && invoice.references?.some((reference) => !reference.reference_date)) {
			return {
				valid: false,
				error: 'Factura de Chile con referencias sin reference_date. El campo date es obligatorio para l10n_cl_reference_ids',
			};
		}

		return { valid: true };
	}

	async calculateInvoiceAmountsAtIssue(invoice: InvoiceWithRelations): Promise<{
		success: boolean;
		usedFallback: boolean;
		exchangeRate?: number;
		fallbackDate?: Date;
	}> {
		// MULTIMONEDA (MM4, spec-multimoneda §4 "Envío al ERP"; cambio puntual avisado a Leon en `cambios-integracion-para-leon.md` §4):
		// una tasa por par (moneda de la línea → factura), nunca una sola tasa del encabezado. Facturas de una sola moneda: rama de siempre.
		if (InvoiceSchedulerService.requiresPairValuation(invoice)) {
			return this.calculatePairAmountsAtIssue(invoice);
		}

		// U12/B3 (spec facturas §3.2, mapa F5/S6-2): con política fija del contrato y sin tasa en la factura (`fx_contract_to_invoice`
		// NULL), el envío se detiene y avisa (omitida, `exchange_rate`); nunca sale a spot en silencio. La tasa por factura vive en
		// `fx_contract_to_invoice` (valor = fija confirmada desde el Contrato 360; NULL = spot pendiente).
		const fxPolicy = invoice.contract?.fx_invoice_policy ?? null;
		const fixedRate = invoice.fx_contract_to_invoice;

		if (fxPolicy === 'fixed' && !(fixedRate != null && Number(fixedRate) > 0)) {
			throw new Error(
				`La factura ${invoice.invoice_number || invoice.id} usa tipo de cambio fijo (política del contrato) y no tiene tasa: ` +
					`confírmala desde el contrato antes de enviarla.`
			);
		}

		// FX FIJO POR FACTURA (Contratos v2, decisión de Domi 01-10, avisada a Leon en `docs/v2-rediseno/cambios-integracion-para-leon.md`):
		// una tasa fijada explícitamente en la factura desde el 360 (`invoice_items.fx_rate_source` = 'manual' o 'net_exact': tasa por
		// factura, neto exacto o facturación por OC) se respeta aunque la política del contrato sea spot. Una tasa "pegada" por datos
		// heredados (sin ese origen) sigue recalculándose a spot como antes.
		const explicitlyFixed = (invoice.items || []).some((item) =>
			['manual', 'net_exact'].includes(String((item as { fx_rate_source?: string | null }).fx_rate_source ?? ''))
		);

		if ((fxPolicy === 'fixed' || explicitlyFixed) && fixedRate != null && Number(fixedRate) > 0) {
			this.logger.log(
				`💱 FX fijo aplicado para factura ${invoice.invoice_number}: ` +
					`${invoice.contract_currency}/${invoice.invoice_currency} = ${fixedRate} ` +
					`(${fxPolicy === 'fixed' ? "política 'fixed'" : 'tasa fijada en la factura'} — sin consultar Banco Central)`
			);
			return {
				success: true,
				usedFallback: false,
				exchangeRate: Number(fixedRate),
			};
		}

		this.logger.log(`Calculando montos para factura ${invoice.invoice_number} (${invoice.id})`);

		try {
			const exchangeRateResult = await this.exchangeRatesService.getExchangeRateWithFallback(
				invoice.contract_currency,
				invoice.invoice_currency,
				invoice.issue_date
			);

			const exchangeRate = exchangeRateResult.rate;
			const isFallback = exchangeRateResult.is_fallback;

			const invoiceItems = invoice.items || [];
			const amountInvoiceCurrency = Number(invoice.amount_contract_currency) * exchangeRate;
			const vatInvoiceCurrency = invoiceItems.reduce((sum, item) => sum + Number(item.tax_amount_contract_currency || 0) * exchangeRate, 0);
			const totalInvoiceCurrency =
				invoiceItems.length > 0
					? invoiceItems.reduce((sum, item) => sum + Number(item.total_contract_currency || 0) * exchangeRate, 0)
					: amountInvoiceCurrency + vatInvoiceCurrency;

			await this.invoiceRepository.update(invoice.id, {
				amount_invoice_currency: amountInvoiceCurrency,
				vat: vatInvoiceCurrency,
				total_invoice_currency: totalInvoiceCurrency,
				fx_contract_to_invoice: exchangeRate,
			});

			for (const item of invoiceItems) {
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

	/**
	 * ¿La factura se valoriza por par al emitir (MM4)? Sí si el contrato tiene `requires_multicurrency_billing`, si sus líneas vienen en dos o
	 * más monedas, o si alguna línea está en una moneda distinta del `contract_currency` del encabezado (p. ej. un consolidado). Una factura
	 * de una sola moneda (la del encabezado) sigue por la rama de siempre, con los mismos números y campos.
	 */
	static requiresPairValuation(invoice: InvoiceWithRelations): boolean {
		const header = upperCode(invoice.contract_currency);
		const currencies = new Set((invoice.items || []).map((item) => upperCode(item.contract_currency) || header));

		return (
			Boolean(invoice.contract?.requires_multicurrency_billing) ||
			currencies.size > 1 ||
			[...currencies].some((currency) => currency !== header)
		);
	}

	/** Valorización por par con al menos una línea que convierte (moneda de la línea ≠ moneda de factura). */
	static convertsByPair(invoice: InvoiceWithRelations): boolean {
		const header = upperCode(invoice.contract_currency);
		const target = upperCode(invoice.invoice_currency);

		return (
			InvoiceSchedulerService.requiresPairValuation(invoice) &&
			(invoice.items || []).some((item) => (upperCode(item.contract_currency) || header) !== target)
		);
	}

	/**
	 * MM4 · valorización por par al emitir (spec-multimoneda §4, decisión de Domi 01-10: al ERP va siempre la moneda de la factura y la
	 * conversión es directa moneda de la línea → factura, sin pasar por la moneda del contrato). Por cada par presente:
	 * - misma moneda que la factura → tasa 1 (la línea no se toca si ya tiene sus montos en moneda de factura);
	 * - línea ya fijada (`fx_rate_source` contract / manual / net_exact / manual_unify con tasa) → conserva su tasa;
	 * - si no, spot del día de emisión de ESE par (`getExchangeRateWithFallback`); con política fija nunca se sale a spot en silencio.
	 * Si falta la tasa de cualquier par no escribe nada y no envía (`fx_rate_missing` con el par). Escribe cada línea (unitario, subtotal,
	 * IVA, total en moneda de factura, tasa, origen y fecha) y el encabezado = Σ líneas; `fx_contract_to_invoice` del encabezado = la tasa
	 * del único par que convierte, NULL con dos o más. `amount_contract_currency` no se recalcula (tasa pactada ítem → contrato).
	 */
	private async calculatePairAmountsAtIssue(invoice: InvoiceWithRelations): Promise<{
		success: boolean;
		usedFallback: boolean;
		exchangeRate?: number;
		fallbackDate?: Date;
	}> {
		const label = invoice.invoice_number || invoice.id;
		const header = upperCode(invoice.contract_currency);
		const target = upperCode(invoice.invoice_currency);
		const items = invoice.items || [];
		const currencyOf = (item: InvoiceItem) => upperCode(item.contract_currency) || header;
		const keptRate = (item: InvoiceItem) =>
			InvoiceSchedulerService.KEPT_FX_SOURCES.has(String(item.fx_rate_source ?? '')) && Number(item.fx_contract_to_invoice) > 0
				? Number(item.fx_contract_to_invoice)
				: null;
		const fixedPolicy = invoice.contract?.fx_invoice_policy === 'fixed';
		const issueDate = invoice.issue_date instanceof Date ? invoice.issue_date : new Date(invoice.issue_date);
		const spot = new Map<string, { rate: number; rate_date: Date; is_fallback: boolean }>();
		const missing: string[] = [];

		// 1) Tasas: primero se resuelven todos los pares; si falta alguno no se escribe nada (nunca un documento medio valorizado).
		for (const currency of [...new Set(items.filter((item) => currencyOf(item) !== target && keptRate(item) === null).map(currencyOf))]) {
			if (fixedPolicy) {
				missing.push(pairKey(currency, target));
				continue;
			}
			try {
				const result = await this.exchangeRatesService.getExchangeRateWithFallback(currency, target, invoice.issue_date);

				if (!(Number(result?.rate) > 0)) throw new Error('sin tasa');
				spot.set(currency, { rate: Number(result.rate), rate_date: result.rate_date, is_fallback: Boolean(result.is_fallback) });
			} catch {
				missing.push(pairKey(currency, target));
				await this.invoiceNotificationService.sendMissingExchangeRateNotification(invoice, issueDate, currency, target);
			}
		}
		if (missing.length) {
			const issueDateStr = Number.isNaN(issueDate.getTime()) ? String(invoice.issue_date) : issueDate.toISOString().split('T')[0];
			const pairs = missing.map((pair) => pair.replace('>', ' → ')).join(', ');
			const error = new Error(
				fixedPolicy
					? `fx_rate_missing: la factura ${label} usa tipo de cambio fijo y no tiene tasa para ${pairs}: confírmala desde el contrato antes de enviarla.`
					: `fx_rate_missing: no hay tipo de cambio disponible para ${pairs} en fecha ${issueDateStr}. Se ha enviado notificación por correo electrónico.`
			) as Error & { code?: string; pairs?: string[] };

			error.code = 'fx_rate_missing';
			error.pairs = missing;
			throw error;
		}

		// 2) Valorización por línea con la convención del motor (residuo por par a la línea mayor, IVA por línea en moneda de factura).
		const taxed = items.some((item) => Number(item.tax_amount_contract_currency || 0) !== 0);
		const rawTaxRate = Number(invoice.tax_rate || 0);
		const taxRate = taxed ? (rawTaxRate > 0 && rawTaxRate <= 1 ? rawTaxRate * 100 : rawTaxRate) : 0;
		const byId = new Map(items.map((item) => [item.id, item]));
		const valuation = valuateLinesByPair(
			items.map(
				(item): PairLine => ({
					id: item.id,
					currency: currencyOf(item),
					unit_price: Number(item.unit_price_contract_currency || 0),
					subtotal: Number(item.subtotal_contract_currency || 0),
					tax_amount: Number(item.tax_amount_contract_currency || 0),
					period_start: '',
				})
			),
			target,
			(line) => keptRate(byId.get(line.id)!) ?? spot.get(line.currency)?.rate ?? null,
			taxRate
		);

		// 3) Escritura: líneas y encabezado = Σ líneas.
		for (const line of valuation.lines) {
			const item = byId.get(line.id)!;

			if (line.currency === target) {
				if (item.subtotal_invoice_currency !== null && item.subtotal_invoice_currency !== undefined) continue;
				await this.invoiceItemRepository.update(item.id, {
					unit_price_invoice_currency: line.unit_price,
					subtotal_invoice_currency: line.subtotal,
					tax_amount_invoice_currency: line.tax,
					total_invoice_currency: line.total,
					fx_contract_to_invoice: 1,
				});
				continue;
			}
			const spotRate = keptRate(item) === null ? spot.get(line.currency) : undefined;

			await this.invoiceItemRepository.update(item.id, {
				unit_price_invoice_currency: line.unit_price,
				subtotal_invoice_currency: line.subtotal,
				tax_amount_invoice_currency: line.tax,
				total_invoice_currency: line.total,
				fx_contract_to_invoice: line.fx,
				...(spotRate ? { fx_rate_source: 'spot', fx_rate_date: spotRate.rate_date ?? issueDate } : {}),
			});
		}
		const amountInvoiceCurrency = valuation.invoice!.subtotal;
		const vatInvoiceCurrency = valuation.invoice!.tax;
		const totalInvoiceCurrency = valuation.invoice!.total;

		await this.invoiceRepository.update(invoice.id, {
			amount_invoice_currency: amountInvoiceCurrency,
			vat: vatInvoiceCurrency,
			total_invoice_currency: totalInvoiceCurrency,
			fx_contract_to_invoice: valuation.fx,
		});

		for (const [currency, used] of spot) {
			if (!used.is_fallback) continue;
			this.logger.warn(
				`Tipo de cambio fallback usado para factura ${invoice.invoice_number}: ${currency}/${target} = ${used.rate} (fecha: ${used.rate_date})`
			);
			await this.invoiceNotificationService.sendExchangeRateFallbackNotification(invoice, {
				rate: used.rate,
				requestedDate: issueDate,
				usedDate: used.rate_date,
				fromCurrency: currency,
				toCurrency: target,
			});
		}
		this.logger.log(
			`✓ Montos por par calculados para factura ${invoice.invoice_number}: ${target} ${amountInvoiceCurrency.toFixed(2)} ` +
				`(pares: ${valuation.pairs.join(', ') || 'ninguno'}; FX encabezado: ${valuation.fx ?? 'por línea'})`
		);
		const fallback = [...spot.values()].find((used) => used.is_fallback);

		return {
			success: true,
			usedFallback: Boolean(fallback),
			exchangeRate: valuation.fx ?? undefined,
			fallbackDate: fallback?.rate_date,
		};
	}

	/** Orígenes de una tasa ya fijada en la línea que el envío respeta (fija del contrato, por factura, neto exacto, manual de la unificación). */
	private static readonly KEPT_FX_SOURCES: ReadonlySet<string> = new Set(['contract', 'manual', 'net_exact', 'manual_unify']);

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

		const references = await this.invoiceReferenceRepository.find({
			where: { invoice_id: invoice.id },
			order: { created_at: 'ASC' },
		});

		this.logger.log(`   contract encontrado: ${contract ? 'SÍ' : 'NO'} - ID: ${contract?.id || 'N/A'}`);
		this.logger.log(
			`   contract.invoice_terms_and_conditions: ${contract?.invoice_terms_and_conditions ? `SÍ (${contract.invoice_terms_and_conditions.substring(0, 50)}...)` : 'NO/VACÍO'}`
		);
		this.logger.log(`   references recargadas: ${references.length}`);

		(invoice as InvoiceWithRelations).clientEntity = clientEntity;
		(invoice as InvoiceWithRelations).company = company;
		(invoice as InvoiceWithRelations).items = items;
		(invoice as InvoiceWithRelations).contract = contract;
		(invoice as InvoiceWithRelations).references = references;

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
			CLP: 45,
			CLF: 178,
			MXN: 33,
			COP: 8,
			PEN: 162,
			EUR: 1,
			UYU: 46,
			UF: 171,
			UYI: 182,
		};

		return currencyMap[currency];
	}

	/**
	 * Obtiene el ID de Odoo para un tipo de documento consultando dinámicamente
	 */
	private async getOdooDocumentTypeId(holdingId: string, documentTypeCode: string, countryName?: string): Promise<number | null> {
		try {
			const odooId = await this.documentTypeMappingService.getOdooDocumentTypeId(holdingId, documentTypeCode, countryName);
			if (!odooId) {
				this.logger.warn(
					`⚠️ Tipo de documento "${documentTypeCode}" no encontrado en Odoo${countryName ? ` para país "${countryName}"` : ''}`
				);
			}
			return odooId;
		} catch (error) {
			this.logger.error(`Error obteniendo ID de Odoo para tipo "${documentTypeCode}": ${error.message}`);
			return null;
		}
	}

	private async getProductMappingInfo(
		sapiraProductId: string,
		holdingId: string
	): Promise<{
		odooProductId: number | null;
		source: 'mapping' | 'product_table' | 'missing';
	}> {
		try {
			// 1. Buscar en odoo_product_mappings
			const mapping = await this.odooProductMappingRepository.findOne({
				where: {
					sapira_product_id: sapiraProductId,
					holding_id: holdingId,
				},
				order: { updated_at: 'DESC' },
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

			// 3. Sin mapeo: ya NO se usa el producto 1 por defecto (Contratos v2, cambio puntual avisado a Leon): quien llama rechaza la
			// factura con `product_without_erp_mapping`.
			this.logger.warn(`Producto ${sapiraProductId}: Sin mapeo a Odoo - la factura no se envía`);
			return {
				odooProductId: null,
				source: 'missing',
			};
		} catch (error) {
			// Un error de lectura tampoco cae al producto 1: se propaga y la factura queda en error.
			this.logger.error(`Error obteniendo mapeo de producto ${sapiraProductId}:`, error);
			throw error;
		}
	}

	/**
	 * Líneas que viajan al ERP (mismo criterio de `mapInvoiceToOdooFormat`): las visibles (`visible_line_id` NULL) con cantidad ≠ 0; si
	 * todas las visibles están en 0, todas las visibles. Lo replica `UNMAPPED_PRODUCTS_SQL` (`contracts/contract-360.ts`) para los bloqueos.
	 */
	static itemsSentToErp<T extends { quantity?: unknown; visible_line_id?: unknown }>(invoice: { items?: T[] }): T[] {
		const isZeroQuantity = (item: T) => Number(item.quantity) === 0;
		const isInternal = (item: T) => item.visible_line_id !== null && item.visible_line_id !== undefined;
		const externalItems = (invoice.items || []).filter((item) => !isInternal(item));

		return externalItems.some((item) => !isZeroQuantity(item)) ? externalItems.filter((item) => !isZeroQuantity(item)) : externalItems;
	}

	/**
	 * Productos de las líneas que viajarían al ERP sin producto de Odoo resoluble (`odoo_product_mappings` del holding ∪
	 * `products.odoo_product_id`) y líneas sin producto. Antes caían en silencio al producto 1 de Odoo; ahora la factura se rechaza.
	 */
	async findUnmappedProducts(invoice: InvoiceWithRelations): Promise<string[]> {
		const missing = new Set<string>();

		for (const item of InvoiceSchedulerService.itemsSentToErp(invoice)) {
			if (!item.product_id) {
				missing.add(`línea sin producto${item.description ? ` (${item.description})` : ''}`);
				continue;
			}
			const mappingInfo = await this.getProductMappingInfo(item.product_id, invoice.holding_id);

			if (mappingInfo.odooProductId === null) {
				const product = await this.productRepository.findOne({ where: { id: item.product_id } });

				missing.add(product?.name?.trim() || item.product_id);
			}
		}

		return [...missing];
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

	async debugInvoice(invoiceId: string): Promise<any> {
		this.logger.log(`🔍 DEBUG: Analizando factura ${invoiceId}`);

		const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId } });

		if (!invoice) {
			return {
				error: 'Factura no encontrada',
				invoiceId,
			};
		}

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

		const issueDate = invoice.issue_date instanceof Date ? invoice.issue_date : new Date(invoice.issue_date);
		const today = new Date();
		today.setHours(23, 59, 59, 999);

		this.logger.log(`🔍 Validando issue_date_same_month para factura ${invoice.id}:`);
		this.logger.log(`   invoice.issue_date: ${invoice.issue_date} (type: ${typeof invoice.issue_date})`);
		this.logger.log(`   new Date(): ${new Date().toISOString()}`);

		const checks = {
			status_is_por_emitir: invoice.status === 'Por Emitir',
			issue_date_lte_today: issueDate <= today,
			sent_to_odoo_at_is_null: invoice.sent_to_odoo_at === null,
			issue_date_same_month: this.isSameMonth(invoice.issue_date, new Date()),
			client_entity_exists: !!clientEntity,
			client_has_odoo_partner_id: !!clientEntity?.odoo_partner_id,
			company_exists: !!company,
			company_has_odoo_integration_id: !!company?.odoo_integration_id,
			contract_exists: !!contract,
			contract_auto_send_to_odoo: contract?.auto_send_to_odoo === true || contract?.auto_send_to_odoo === null,
			has_items: items.length > 0,
		};

		const allChecksPassed = Object.values(checks).every((check) => check === true);

		const result = {
			invoice: {
				id: invoice.id,
				invoice_number: invoice.invoice_number,
				status: invoice.status,
				issue_date: invoice.issue_date,
				sent_to_odoo_at: invoice.sent_to_odoo_at,
				holding_id: invoice.holding_id,
				contract_id: invoice.contract_id,
				client_entity_id: invoice.client_entity_id,
				company_id: invoice.company_id,
			},
			client_entity: clientEntity
				? {
						id: clientEntity.id,
						legal_name: clientEntity.legal_name,
						odoo_partner_id: clientEntity.odoo_partner_id,
					}
				: null,
			company: company
				? {
						id: company.id,
						legal_name: company.legal_name,
						odoo_integration_id: company.odoo_integration_id,
					}
				: null,
			contract: contract
				? {
						id: contract.id,
						contract_number: contract.contract_number,
						auto_send_to_odoo: contract.auto_send_to_odoo,
					}
				: null,
			items_count: items.length,
			checks,
			all_checks_passed: allChecksPassed,
			would_be_processed: allChecksPassed,
			failed_checks: Object.entries(checks)
				.filter(([, value]) => !value)
				.map(([key]) => key),
		};

		this.logger.log(`📊 Resultado del debug:`);
		this.logger.log(`   - Todos los checks pasaron: ${allChecksPassed}`);
		this.logger.log(`   - Checks fallidos: ${result.failed_checks.join(', ') || 'ninguno'}`);

		return result;
	}

	private isSameMonth(date1: Date | string, date2: Date): boolean {
		// Convertir a string ISO y extraer año-mes
		const getYearMonth = (d: Date | string): string => {
			if (typeof d === 'string') {
				// Si es string, tomar directamente los primeros 7 caracteres (YYYY-MM)
				return d.substring(0, 7);
			}
			// Si es Date, convertir a ISO y tomar año-mes
			return d.toISOString().substring(0, 7);
		};

		const yearMonth1 = getYearMonth(date1);
		const yearMonth2 = getYearMonth(date2);
		const result = yearMonth1 === yearMonth2;

		this.logger.debug(`🗓️  isSameMonth check:`);
		this.logger.debug(`   date1: ${date1} → yearMonth: ${yearMonth1}`);
		this.logger.debug(`   date2: ${date2} → yearMonth: ${yearMonth2}`);
		this.logger.debug(`   result: ${result}`);

		return result;
	}

	async debugInvoicesToday(holdingId?: string): Promise<any> {
		this.logger.log(`🔍 DEBUG: Analizando facturas con issue_date de hoy`);

		const todayStr = this.getBusinessTodayString();

		const query = this.invoiceRepository
			.createQueryBuilder('inv')
			.where('inv.status = :status', { status: 'Por Emitir' })
			.andWhere('DATE(inv.issue_date) = :today', { today: todayStr });

		if (holdingId) {
			query.andWhere('inv.holding_id = :holdingId', { holdingId });
		}

		const invoices = await query.getMany();

		this.logger.log(`📊 Encontradas ${invoices.length} facturas con issue_date de hoy`);

		const results = [];
		const summary = {
			total: invoices.length,
			would_be_processed: 0,
			would_be_skipped: 0,
			failed_checks_summary: {},
		};

		for (const invoice of invoices) {
			const debugResult = await this.debugInvoice(invoice.id);
			results.push(debugResult);

			if (debugResult.would_be_processed) {
				summary.would_be_processed++;
			} else {
				summary.would_be_skipped++;

				debugResult.failed_checks.forEach((check) => {
					if (!summary.failed_checks_summary[check]) {
						summary.failed_checks_summary[check] = 0;
					}
					summary.failed_checks_summary[check]++;
				});
			}
		}

		this.logger.log(`📊 Resumen:`);
		this.logger.log(`   - Total: ${summary.total}`);
		this.logger.log(`   - Se procesarían: ${summary.would_be_processed}`);
		this.logger.log(`   - Se omitirían: ${summary.would_be_skipped}`);
		this.logger.log(`   - Checks fallidos más comunes:`, summary.failed_checks_summary);

		return {
			summary,
			invoices: results,
			debug_date: todayStr,
			holding_id: holdingId || 'all',
		};
	}

	private async createOdooSendLog(params: {
		holdingId: string;
		operation: string;
		status: string;
		invoiceId: string;
		invoiceNumber: string;
		clientName: string;
		companyName: string;
		invoiceCurrency?: string;
		invoiceAmount?: number;
		odooInvoiceId?: number;
		requestData?: any;
		responseData?: any;
		errorMessage?: string;
		errorType?: string;
		errorDetails?: any;
		durationMs?: number;
	}): Promise<InvoiceOdooSendLogDocument> {
		const log = new this.invoiceOdooSendLogModel({
			holding_id: params.holdingId,
			invoice_id: params.invoiceId,
			invoice_number: params.invoiceNumber,
			odoo_invoice_id: params.odooInvoiceId,
			operation: params.operation,
			status: params.status,
			execution_environment: this.getExecutionEnvironment(),
			client_name: params.clientName,
			company_name: params.companyName,
			invoice_currency: params.invoiceCurrency,
			invoice_amount: params.invoiceAmount,
			request_data: params.requestData,
			response_data: params.responseData,
			error_message: params.errorMessage,
			error_type: params.errorType,
			error_details: params.errorDetails,
			duration_ms: params.durationMs,
		});

		return await log.save();
	}

	/**
	 * Notificación de fallo del envío al ERP. El texto que ve la usuaria sale de `translateErpError` (Contratos v2, cambio puntual avisado
	 * a Leon §9): título "No se pudo enviar la factura <folio> de <cliente>", cuerpo = qué pasó + paso siguiente; el detalle técnico
	 * (`title`/`message`/`errorMessage` de quien llama) queda en `metadata` (`technical_title`, `technical_message`, `error_message`).
	 */
	private async createOdooFailureNotification(params: {
		invoice: InvoiceWithRelations;
		stage: 'create_draft' | 'post_invoice' | 'emit_electronic_invoice' | 'send_invoice_to_customer' | 'product_mapping';
		title: string;
		message: string;
		errorType: string;
		errorMessage: string;
		odooInvoiceId?: number;
		schedulerSource: 'manual' | 'automatic';
		responseData?: any;
		errorDetails?: any;
	}): Promise<void> {
		if (!params.invoice.contract_id) {
			this.logger.warn(`⚠️ No se pudo crear notificación de error Odoo para factura ${params.invoice.id} porque no tiene contract_id`);
			return;
		}

		try {
			const translation = translateErpError(params.errorMessage, params.errorType);
			const folio = params.invoice.invoice_number || 'sin folio';
			const client = params.invoice.clientEntity?.legal_name?.trim() || 'cliente sin razón social';
			const metadata = {
				source: 'invoice_scheduler',
				scheduler_source: params.schedulerSource,
				invoice_id: params.invoice.id,
				invoice_number: params.invoice.invoice_number,
				odoo_invoice_id: params.odooInvoiceId,
				failure_stage: params.stage,
				error_type: params.errorType,
				error_message: params.errorMessage,
				technical_title: params.title,
				technical_message: params.message,
				erp_error: {
					category: translation.category,
					message: translation.message,
					next_step: translation.next_step,
					action: translation.action,
				},
				country: params.invoice.company?.country || null,
				client_name: params.invoice.clientEntity?.legal_name || null,
				company_name: params.invoice.company?.legal_name || null,
				response_data: params.responseData || null,
				error_details: params.errorDetails || null,
			};

			await this.notificationsService.createOrUpdate(params.invoice.holding_id, {
				source: 'invoices',
				type: INVOICE_ODOO_FAILURE_NOTIFICATION_TYPE,
				severity: 'error',
				title: `No se pudo enviar la factura ${folio} de ${client}`,
				message: erpErrorSentence(translation),
				recommendation: translation.next_step,
				action_type: 'open_contract',
				action_payload: { contract_id: params.invoice.contract_id },
				resource_type: 'invoice',
				resource_id: params.invoice.id,
				metadata: {
					...metadata,
					contract_id: params.invoice.contract_id,
				},
				deduplication_key: `invoice-odoo-failure:${params.invoice.id}:${params.stage}:${params.errorType}`,
			});
		} catch (error) {
			this.logger.error(`❌ Error creando notificación para factura ${params.invoice.invoice_number || params.invoice.id}:`, error);
		}
	}

	/**
	 * Último intento de envío al ERP de una factura (el log `invoice_odoo_send_logs`, donde el scheduler ya guarda cada intento, manual o
	 * automático), traducido con `translateErpError`. null si nunca se intentó o si el log no responde (no bloquea el detalle).
	 */
	async lastSendAttempt(invoiceId: string, holdingId: string): Promise<LastSendAttempt | null> {
		try {
			const log = (await this.invoiceOdooSendLogModel
				.findOne({ invoice_id: invoiceId, holding_id: holdingId })
				.sort({ createdAt: -1 })
				.lean()
				.exec()) as (InvoiceOdooSendLog & { createdAt?: Date }) | null;

			return log ? lastSendAttemptOf(log) : null;
		} catch (error) {
			this.logger.warn(`No se pudo leer el último intento de envío de la factura ${invoiceId}: ${(error as Error).message}`);
			return null;
		}
	}

	async startSchedulerJob(options: ProcessOptions & { userId: string }): Promise<string> {
		const { dryRun, holdingId, contractId, userId } = options;
		const jobId = uuidv4();

		this.logger.log(`🆕 Creando job ${jobId} - DryRun: ${dryRun}, HoldingId: ${holdingId || 'todos'}, ContractId: ${contractId || 'todos'}`);

		const job = new this.invoiceSchedulerJobModel({
			jobId,
			holdingId: holdingId || 'all',
			contractId,
			dryRun,
			executionEnvironment: this.getExecutionEnvironment(),
			executionSource: 'manual' as ExecutionSource,
			status: 'pending',
			progress: {
				total: 0,
				sent: 0,
				errors: 0,
				skipped: 0,
				current: 0,
			},
			userId,
			startedAt: new Date(),
		});

		await job.save();

		setImmediate(() => {
			this.processInvoicesAsync(jobId, options).catch((error) => {
				this.logger.error(`❌ Error en procesamiento asíncrono del job ${jobId}:`, error);
			});
		});

		return jobId;
	}

	private async processInvoicesAsync(jobId: string, options: ProcessOptions & { userId: string }): Promise<void> {
		const { dryRun, holdingId, contractId, userId } = options;

		try {
			await this.invoiceSchedulerJobModel.updateOne({ jobId }, { status: 'running' });

			const invoices = await this.getInvoicesToSend(holdingId, contractId);
			const total = invoices.length;

			this.logger.log(`📋 Job ${jobId}: Encontradas ${total} facturas para procesar`);

			this.schedulerGateway.emitJobStarted(jobId, holdingId || 'all', userId, dryRun, total);

			await this.invoiceSchedulerJobModel.updateOne(
				{ jobId },
				{
					'progress.total': total,
				}
			);

			const results: InvoiceResultDto[] = [];
			const summary: ProcessInvoicesSummaryDto = {
				total,
				sent: 0,
				errors: 0,
				skipped: 0,
			};

			let current = 0;
			let lastProgressEmit = Date.now();

			for (const invoice of invoices) {
				current++;
				const result = await this.sendInvoiceToOdoo(invoice, dryRun, 'manual');
				results.push(result);

				if (result.status === 'sent') {
					summary.sent++;
				} else if (result.status === 'error') {
					summary.errors++;
				} else {
					summary.skipped++;
				}

				const now = Date.now();
				if (now - lastProgressEmit >= 2000 || current === total) {
					const progress: SchedulerJobProgressDto = {
						total,
						current,
						sent: summary.sent,
						errors: summary.errors,
						skipped: summary.skipped,
					};

					await this.invoiceSchedulerJobModel.updateOne({ jobId }, { progress });

					this.schedulerGateway.emitJobProgress(jobId, holdingId || 'all', userId, progress);
					lastProgressEmit = now;
				}
			}

			const response: ProcessInvoicesResponseDto = {
				success: summary.errors < summary.total,
				dryRun,
				summary,
				results,
				executedAt: new Date(),
			};

			await this.invoiceSchedulerJobModel.updateOne(
				{ jobId },
				{
					status: 'completed',
					result: response,
					completedAt: new Date(),
				}
			);

			await this.sendErrorSummaryNotification({
				jobId,
				holdingId: holdingId || 'all',
				dryRun,
				executionSource: 'manual',
				executionEnvironment: this.getExecutionEnvironment(),
				startedAt: response.executedAt,
				result: response,
			});

			this.schedulerGateway.emitJobCompleted(jobId, holdingId || 'all', userId, response);

			this.logger.log(
				`✅ Job ${jobId} completado - Total: ${total}, Enviadas: ${summary.sent}, Errores: ${summary.errors}, Omitidas: ${summary.skipped}`
			);
		} catch (error) {
			this.logger.error(`❌ Error en job ${jobId}:`, error);

			await this.invoiceSchedulerJobModel.updateOne(
				{ jobId },
				{
					status: 'failed',
					error: error.message || 'Error desconocido',
					completedAt: new Date(),
				}
			);

			this.schedulerGateway.emitJobError(jobId, holdingId || 'all', userId, error.message || 'Error desconocido');
		}
	}

	async getJobStatus(jobId: string): Promise<InvoiceSchedulerJobDocument | null> {
		return await this.invoiceSchedulerJobModel.findOne({ jobId }).exec();
	}

	async getRecentJobs(holdingId: string, userId: string, limit: number = 10): Promise<InvoiceSchedulerJobDocument[]> {
		return await this.invoiceSchedulerJobModel
			.find({
				$or: [{ holdingId }, { holdingId: 'all' }],
				userId,
			})
			.sort({ createdAt: -1 })
			.limit(limit)
			.exec();
	}

	async getJobsReport(query: SchedulerReportQueryDto, allowedHoldingIds?: string[]): Promise<SchedulerReportResponseDto> {
		const match: Record<string, any> = {};
		if (query.environment) match.executionEnvironment = query.environment;
		if (query.source) match.executionSource = query.source;
		if (allowedHoldingIds) {
			// Usuario no super admin: solo ejecuciones de SUS holdings. Si además pidió un
			// holding puntual, se respeta solo si le pertenece; si no, resultado vacío.
			if (query.holdingId) {
				match.holdingId = allowedHoldingIds.includes(query.holdingId) ? query.holdingId : '__sin_acceso__';
			} else {
				match.holdingId = { $in: allowedHoldingIds };
			}
		} else if (query.holdingId) match.holdingId = query.holdingId;
		if (query.dryRun !== undefined) match.dryRun = query.dryRun === 'true';

		if (query.from || query.to) {
			match.startedAt = {};
			if (query.from) match.startedAt.$gte = new Date(`${query.from}T00:00:00.000Z`);
			if (query.to) {
				const end = new Date(`${query.to}T00:00:00.000Z`);
				end.setUTCDate(end.getUTCDate() + 1);
				match.startedAt.$lt = end;
			}
		}

		const errorProjection = {
			$map: {
				input: {
					$filter: {
						input: { $ifNull: ['$result.results', []] },
						as: 'result',
						cond: { $eq: ['$$result.status', 'error'] },
					},
				},
				as: 'result',
				in: { $trim: { input: { $ifNull: ['$$result.error', 'Error sin detalle'] } } },
			},
		};
		const basePipeline: any[] = [
			{ $match: match },
			{
				$project: {
					jobId: 1,
					holdingId: 1,
					executionEnvironment: { $ifNull: ['$executionEnvironment', 'unknown'] },
					executionSource: { $ifNull: ['$executionSource', 'manual'] },
					dryRun: 1,
					status: 1,
					startedAt: 1,
					completedAt: 1,
					error: 1,
					progress: 1,
					durationMs: {
						$cond: [{ $and: ['$startedAt', '$completedAt'] }, { $subtract: ['$completedAt', '$startedAt'] }, null],
					},
					errors: errorProjection,
					invoiceResults: {
						$map: {
							input: { $ifNull: ['$result.results', []] },
							as: 'result',
							in: {
								invoiceId: '$$result.invoiceId',
								holdingId: '$$result.holdingId',
								invoiceNumber: '$$result.invoiceNumber',
								clientName: '$$result.clientName',
								companyName: '$$result.companyName',
								issueDate: '$$result.issueDate',
								status: '$$result.status',
								odooInvoiceId: '$$result.odooInvoiceId',
								error: '$$result.error',
								details: '$$result.details',
							},
						},
					},
					errorInvoices: {
						$map: {
							input: {
								$filter: {
									input: { $ifNull: ['$result.results', []] },
									as: 'result',
									cond: { $eq: ['$$result.status', 'error'] },
								},
							},
							as: 'result',
							in: {
								invoiceId: '$$result.invoiceId',
								holdingId: '$$result.holdingId',
								invoiceNumber: '$$result.invoiceNumber',
								clientName: '$$result.clientName',
								companyName: '$$result.companyName',
								issueDate: '$$result.issueDate',
								odooInvoiceId: '$$result.odooInvoiceId',
								error: '$$result.error',
								details: '$$result.details',
							},
						},
					},
				},
			},
			{
				$addFields: {
					distinctErrors: {
						$map: {
							input: { $setUnion: ['$errors', []] },
							as: 'message',
							in: {
								message: '$$message',
								count: {
									$size: {
										$filter: {
											input: '$errors',
											as: 'errorMessage',
											cond: { $eq: ['$$errorMessage', '$$message'] },
										},
									},
								},
							},
						},
					},
				},
			},
			{ $project: { errors: 0 } },
		];
		const page = query.page || 1;
		const limit = query.limit || 25;
		const [items, total, summaryRows] = await Promise.all([
			this.invoiceSchedulerJobModel
				.aggregate([...basePipeline, { $sort: { startedAt: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }])
				.exec(),
			this.invoiceSchedulerJobModel.countDocuments(match).exec(),
			this.invoiceSchedulerJobModel
				.aggregate([
					{ $match: match },
					{
						$group: {
							_id: null,
							executions: { $sum: 1 },
							total: { $sum: { $ifNull: ['$progress.total', 0] } },
							sent: { $sum: { $ifNull: ['$progress.sent', 0] } },
							errors: { $sum: { $ifNull: ['$progress.errors', 0] } },
							skipped: { $sum: { $ifNull: ['$progress.skipped', 0] } },
						},
					},
				])
				.exec(),
		]);

		const summary = summaryRows[0] || { executions: 0, total: 0, sent: 0, errors: 0, skipped: 0 };
		delete summary._id;

		const holdingIds = [
			...new Set(
				items
					.flatMap((item) => [
						item.holdingId,
						...(item.invoiceResults || []).map((invoice) => invoice.holdingId),
						...(item.errorInvoices || []).map((invoice) => invoice.holdingId),
					])
					.filter((holdingId): holdingId is string => Boolean(holdingId) && holdingId !== 'all')
			),
		];
		const holdings: Array<{ id: string; name: string }> = holdingIds.length
			? ((await this.dataSource.query('SELECT id, name FROM company_holdings WHERE id = ANY($1)', [holdingIds])) as Array<{
					id: string;
					name: string;
				}>)
			: [];
		const holdingNames = new Map(holdings.map((holding) => [holding.id, holding.name]));
		const itemsWithHoldingNames = items.map((item) => ({
			...item,
			holdingName: holdingNames.get(item.holdingId),
			invoiceResults: (item.invoiceResults || []).map((invoice) => ({
				...invoice,
				holdingName: holdingNames.get(invoice.holdingId),
			})),
			errorInvoices: (item.errorInvoices || []).map((invoice) => ({
				...invoice,
				holdingName: holdingNames.get(invoice.holdingId),
			})),
		}));

		return { items: itemsWithHoldingNames, total, page, limit, summary };
	}

	async createSystemSchedulerJob(options: ProcessOptions): Promise<string> {
		const { dryRun, holdingId, contractId } = options;
		const jobId = uuidv4();
		const userId = 'system-scheduler';

		this.logger.log(
			`🆕 Creando job del sistema ${jobId} - DryRun: ${dryRun}, HoldingId: ${holdingId || 'todos'}, ContractId: ${contractId || 'todos'}`
		);

		const job = new this.invoiceSchedulerJobModel({
			jobId,
			holdingId: holdingId || 'all',
			contractId,
			dryRun,
			executionEnvironment: this.getExecutionEnvironment(),
			executionSource: 'automatic' as ExecutionSource,
			status: 'running',
			progress: {
				total: 0,
				sent: 0,
				errors: 0,
				skipped: 0,
				current: 0,
			},
			userId,
			startedAt: new Date(),
		});

		await job.save();

		return jobId;
	}

	async updateSchedulerJobResult(jobId: string, result: ProcessInvoicesResponseDto): Promise<void> {
		await this.invoiceSchedulerJobModel.updateOne(
			{ jobId },
			{
				status: 'completed',
				result,
				progress: {
					total: result.summary.total,
					sent: result.summary.sent,
					errors: result.summary.errors,
					skipped: result.summary.skipped,
					current: result.summary.total,
				},
				completedAt: new Date(),
			}
		);

		this.logger.log(
			`✅ Job del sistema ${jobId} completado - Total: ${result.summary.total}, Enviadas: ${result.summary.sent}, ` +
				`Errores: ${result.summary.errors}, Omitidas: ${result.summary.skipped}`
		);

		const job = await this.invoiceSchedulerJobModel.findOne({ jobId }).lean().exec();
		await this.sendErrorSummaryNotification({
			jobId,
			holdingId: job?.holdingId || 'all',
			dryRun: result.dryRun,
			executionSource: job?.executionSource || 'automatic',
			executionEnvironment: job?.executionEnvironment || 'unknown',
			startedAt: job?.startedAt || result.executedAt,
			result,
		});
	}

	async updateSchedulerJobError(jobId: string, error: Error): Promise<void> {
		await this.invoiceSchedulerJobModel.updateOne(
			{ jobId },
			{
				status: 'failed',
				error: error.message || 'Error desconocido',
				completedAt: new Date(),
			}
		);

		this.logger.error(`❌ Job del sistema ${jobId} falló: ${error.message}`);
	}

	private async sendErrorSummaryNotification(params: {
		jobId: string;
		holdingId: string;
		dryRun: boolean;
		executionSource: ExecutionSource;
		executionEnvironment: ExecutionEnvironment;
		startedAt: Date;
		result: ProcessInvoicesResponseDto;
	}): Promise<void> {
		// Sin errores igual se llama: cierra la alerta del día (Notificaciones v2 fase 2).
		if (params.dryRun) return;

		const errors = new Map<string, number>();
		for (const result of params.result.results) {
			if (result.status !== 'error') continue;
			const message = result.error?.trim() || 'Error sin detalle';
			errors.set(message, (errors.get(message) || 0) + 1);
		}

		await this.invoiceNotificationService.sendSchedulerErrorSummary({
			...params,
			distinctErrors: Array.from(errors, ([message, count]) => ({ message, count })),
		});
	}
}
