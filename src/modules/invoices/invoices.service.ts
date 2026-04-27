import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';

import { ExchangeRatesService } from '../banco-central/services/exchange-rates.service';

import {
	BulkUpdateCurrencyResponseDto,
	BulkUpdateErrorDto,
	BulkUpdateSummaryDto,
	BulkUpdateWarningDto,
} from './dtos/bulk-update-currency-response.dto';
import { BulkUpdateCurrencyDto } from './dtos/bulk-update-currency.dto';
import { RecalculateTaxesBatchDto, RecalculateTaxesBatchResponseDto, RecalculateTaxesResponseDto } from './dtos/recalculate-taxes.dto';
import { InvoiceItem } from './entities/invoice-item.entity';
import { Invoice } from './entities/invoice.entity';

@Injectable()
export class InvoicesService {
	private readonly logger = new Logger(InvoicesService.name);

	constructor(
		@InjectRepository(Invoice)
		private readonly invoiceRepository: Repository<Invoice>,
		@InjectRepository(InvoiceItem)
		private readonly invoiceItemRepository: Repository<InvoiceItem>,
		@InjectRepository(ClientEntity)
		private readonly clientEntityRepository: Repository<ClientEntity>,
		private readonly exchangeRatesService: ExchangeRatesService,
		private readonly dataSource: DataSource
	) {}

	async bulkUpdateCurrency(dto: BulkUpdateCurrencyDto): Promise<BulkUpdateCurrencyResponseDto> {
		const { invoiceIds, newCurrency, dryRun = false } = dto;

		this.logger.log(`Iniciando bulk update de moneda a ${newCurrency} para ${invoiceIds.length} facturas (dryRun: ${dryRun})`);

		const warnings: BulkUpdateWarningDto[] = [];
		const errors: BulkUpdateErrorDto[] = [];
		const summary: BulkUpdateSummaryDto = {
			withAutomaticFx: 0,
			withFallbackFx: 0,
			withoutFx: 0,
			sameCurrency: 0,
		};

		// 1. Obtener facturas
		const invoices = await this.invoiceRepository.findBy({ id: In(invoiceIds) });

		if (invoices.length === 0) {
			throw new BadRequestException('No se encontraron facturas con los IDs proporcionados');
		}

		// 2. Validar que todas estén en estado "Por Emitir"
		const invalidInvoices = invoices.filter((inv) => inv.status !== 'Por Emitir');
		if (invalidInvoices.length > 0) {
			throw new BadRequestException(
				`Solo se pueden actualizar facturas en estado "Por Emitir". ` +
					`Facturas inválidas: ${invalidInvoices.map((i) => i.invoice_number || i.id).join(', ')}`
			);
		}

		// 3. Procesar cada factura
		let updatedCount = 0;

		for (const invoice of invoices) {
			try {
				const isDifferentCurrency = invoice.contract_currency !== newCurrency;

				if (!isDifferentCurrency) {
					// Caso A: Misma moneda del contrato
					await this.updateInvoiceSameCurrency(invoice, newCurrency, dryRun);
					summary.sameCurrency++;
					updatedCount++;
				} else {
					// Caso B: Moneda diferente - intentar obtener tipo de cambio
					const fxResult = await this.updateInvoiceDifferentCurrency(invoice, newCurrency, dryRun);

					if (fxResult.type === 'AUTOMATIC') {
						summary.withAutomaticFx++;
					} else if (fxResult.type === 'FALLBACK') {
						summary.withFallbackFx++;
						warnings.push({
							invoiceId: invoice.id,
							invoiceNumber: invoice.invoice_number || invoice.id,
							type: 'FALLBACK_FX',
							message: fxResult.message,
							fallbackExchangeRate: fxResult.fallbackInfo,
						});
					} else if (fxResult.type === 'MISSING') {
						summary.withoutFx++;
						warnings.push({
							invoiceId: invoice.id,
							invoiceNumber: invoice.invoice_number || invoice.id,
							type: 'MISSING_FX',
							message: fxResult.message,
							missingExchangeRate: fxResult.missingInfo,
						});
					}

					updatedCount++;
				}
			} catch (error) {
				this.logger.error(`Error actualizando factura ${invoice.id}: ${error.message}`, error.stack);
				errors.push({
					invoiceId: invoice.id,
					invoiceNumber: invoice.invoice_number || invoice.id,
					error: error.message,
				});
			}
		}

		this.logger.log(
			`Bulk update completado: ${updatedCount}/${invoiceIds.length} facturas actualizadas, ` +
				`${warnings.length} warnings, ${errors.length} errores`
		);

		return {
			success: errors.length === 0,
			updatedCount,
			totalRequested: invoiceIds.length,
			dryRun,
			summary,
			warnings,
			errors,
		};
	}

	private async updateInvoiceSameCurrency(invoice: Invoice, newCurrency: string, dryRun: boolean): Promise<void> {
		if (!dryRun) {
			// Actualizar factura
			await this.invoiceRepository.update(invoice.id, {
				invoice_currency: newCurrency,
				amount_invoice_currency: invoice.amount_contract_currency,
				fx_contract_to_invoice: 1,
			});

			// Actualizar items
			const items = await this.invoiceItemRepository.find({ where: { invoice_id: invoice.id } });

			for (const item of items) {
				await this.invoiceItemRepository.update(item.id, {
					invoice_currency: newCurrency,
					unit_price_invoice_currency: item.unit_price_contract_currency,
					subtotal_invoice_currency: item.subtotal_contract_currency,
					tax_amount_invoice_currency: item.tax_amount_contract_currency,
					total_invoice_currency: item.total_contract_currency,
					fx_contract_to_invoice: 1,
				});
			}
		}

		this.logger.debug(`Factura ${invoice.id}: misma moneda, FX = 1`);
	}

	private async updateInvoiceDifferentCurrency(
		invoice: Invoice,
		newCurrency: string,
		dryRun: boolean
	): Promise<{
		type: 'AUTOMATIC' | 'FALLBACK' | 'MISSING';
		message?: string;
		fallbackInfo?: { usedDate: string; requestedDate: string; rate: number };
		missingInfo?: { fromCurrency: string; toCurrency: string; requestedDate: string };
	}> {
		// Solo actualizar moneda, sin calcular montos
		// Los montos se calcularán al momento de emitir la factura usando issue_date
		if (!dryRun) {
			// Actualizar factura - solo moneda, montos en NULL
			await this.invoiceRepository.update(invoice.id, {
				invoice_currency: newCurrency,
				amount_invoice_currency: null,
				total_invoice_currency: null,
				vat: null,
				fx_contract_to_invoice: null,
			});

			// Actualizar items - solo moneda, montos en NULL
			const items = await this.invoiceItemRepository.find({ where: { invoice_id: invoice.id } });

			for (const item of items) {
				await this.invoiceItemRepository.update(item.id, {
					invoice_currency: newCurrency,
					unit_price_invoice_currency: null,
					subtotal_invoice_currency: null,
					tax_amount_invoice_currency: null,
					total_invoice_currency: null,
					fx_contract_to_invoice: null,
				});
			}
		}

		this.logger.debug(
			`Factura ${invoice.id}: Moneda actualizada a ${newCurrency}. Los montos se calcularán al momento de emisión usando issue_date.`
		);

		// Convertir issue_date a string (puede venir como Date o string desde la BD)
		const issueDateStr = invoice.issue_date
			? invoice.issue_date instanceof Date
				? invoice.issue_date.toISOString().split('T')[0]
				: String(invoice.issue_date)
			: new Date().toISOString().split('T')[0];

		return {
			type: 'MISSING',
			message: `Moneda actualizada a ${newCurrency}. Los montos se calcularán automáticamente al emitir la factura usando el tipo de cambio de la fecha de emisión.`,
			missingInfo: {
				fromCurrency: invoice.contract_currency,
				toCurrency: newCurrency,
				requestedDate: issueDateStr,
			},
		};
	}

	async updateAutoInvoice(invoiceId: string, autoInvoice: boolean): Promise<void> {
		const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId } });

		if (!invoice) {
			throw new NotFoundException(`Factura con ID ${invoiceId} no encontrada`);
		}

		await this.invoiceRepository.update(invoiceId, {
			auto_invoice: autoInvoice,
		});

		this.logger.log(`Factura ${invoiceId}: auto_invoice actualizado a ${autoInvoice}`);
	}

	async bulkUpdateAutoInvoiceByContract(contractId: string, autoInvoice: boolean): Promise<number> {
		const result = await this.invoiceRepository
			.createQueryBuilder()
			.update(Invoice)
			.set({ auto_invoice: autoInvoice })
			.where('contract_id = :contractId', { contractId })
			.andWhere('status = :status', { status: 'Por Emitir' })
			.andWhere('sent_to_odoo_at IS NULL')
			.execute();

		const affectedCount = result.affected || 0;

		this.logger.log(`Contrato ${contractId}: ${affectedCount} facturas actualizadas con auto_invoice = ${autoInvoice}`);

		return affectedCount;
	}

	/**
	 * Recalcula los impuestos de una factura aplicando retenciones de Colombia
	 */
	async recalculateInvoiceTaxes(invoiceId: string): Promise<RecalculateTaxesResponseDto> {
		this.logger.log(`🔄 Iniciando recálculo de impuestos para factura ${invoiceId}`);

		const queryRunner = this.dataSource.createQueryRunner();
		await queryRunner.connect();
		await queryRunner.startTransaction();

		try {
			// 1. Obtener factura con relaciones
			const invoice = await queryRunner.manager.findOne(Invoice, {
				where: { id: invoiceId },
			});

			if (!invoice) {
				throw new NotFoundException(`Factura ${invoiceId} no encontrada`);
			}

			// 2. Validar que sea "Por Emitir"
			if (invoice.status !== 'Por Emitir') {
				throw new BadRequestException(`Solo se pueden recalcular facturas en estado "Por Emitir". Estado actual: ${invoice.status}`);
			}

			// 3. Obtener cliente y sus retenciones
			if (!invoice.client_entity_id) {
				throw new BadRequestException('La factura no tiene cliente asociado (client_entity_id)');
			}

			const clientEntity = await queryRunner.manager.findOne(ClientEntity, {
				where: { id: invoice.client_entity_id },
				select: [
					'id',
					'odoo_reteica_tax_id',
					'odoo_reteica_tax_name',
					'odoo_reteica_tax_amount',
					'odoo_retefuente_tax_id',
					'odoo_retefuente_tax_name',
					'odoo_retefuente_tax_amount',
					'odoo_reteiva_tax_id',
					'odoo_reteiva_tax_name',
					'odoo_reteiva_tax_amount',
				],
			});

			if (!clientEntity) {
				throw new NotFoundException(`Cliente ${invoice.client_entity_id} no encontrado`);
			}

			// 4. Obtener company para tax_rate (IVA)
			const company = await queryRunner.manager.query(`SELECT tax_rate, country FROM companies WHERE id = $1`, [invoice.company_id]);

			if (!company || company.length === 0) {
				throw new NotFoundException(`Empresa ${invoice.company_id} no encontrada`);
			}

			const companyTaxRate = company[0].tax_rate || 0;
			const companyCountry = company[0].country;

			this.logger.log(`📊 Empresa: ${companyCountry}, IVA: ${companyTaxRate}%`);

			// 5. Calcular retenciones del cliente (convertir a números)
			const retentions = {
				reteica: Number(clientEntity.odoo_reteica_tax_amount) || 0,
				retefuente: Number(clientEntity.odoo_retefuente_tax_amount) || 0,
				reteiva: Number(clientEntity.odoo_reteiva_tax_amount) || 0,
			};

			this.logger.log(`💼 Retenciones: ReteICA ${retentions.reteica}%, Retefuente ${retentions.retefuente}%, ReteIVA ${retentions.reteiva}%`);

			// 6. Obtener items de la factura
			const items = await queryRunner.manager.find(InvoiceItem, {
				where: { invoice_id: invoiceId },
			});

			if (items.length === 0) {
				throw new BadRequestException('La factura no tiene items');
			}

			// 7. Recalcular cada item
			let totalSubtotal = 0;
			let totalTax = 0;
			let totalAmount = 0;

			for (const item of items) {
				// Convertir valores de BD a números
				const subtotal = Number(item.subtotal_invoice_currency) || 0;
				const fxRate = Number(item.fx_contract_to_invoice) || 1;

				// IVA (impuesto positivo)
				const iva = subtotal * (companyTaxRate / 100);

				// Retenciones (impuestos negativos que se restan)
				const reteicaAmount = subtotal * (retentions.reteica / 100);
				const retefuenteAmount = subtotal * (retentions.retefuente / 100);
				const reteivaAmount = subtotal * (retentions.reteiva / 100);

				// Total de impuestos (IVA - retenciones)
				const taxAmount = iva - reteicaAmount - retefuenteAmount - reteivaAmount;

				// Total del item
				const total = subtotal + taxAmount;

				// Actualizar item
				await queryRunner.manager.update(InvoiceItem, item.id, {
					tax_amount_invoice_currency: Number(taxAmount.toFixed(2)),
					tax_amount_contract_currency: Number((taxAmount / fxRate).toFixed(2)),
					total_invoice_currency: Number(total.toFixed(2)),
					total_contract_currency: Number((total / fxRate).toFixed(2)),
				});

				totalSubtotal += subtotal;
				totalTax += taxAmount;
				totalAmount += total;

				this.logger.debug(
					`Item ${item.id}: Subtotal ${subtotal}, IVA ${iva.toFixed(2)}, ` +
						`Retenciones ${(reteicaAmount + retefuenteAmount + reteivaAmount).toFixed(2)}, ` +
						`Tax ${taxAmount.toFixed(2)}, Total ${total.toFixed(2)}`
				);
			}

			// 8. Calcular tasa efectiva de impuestos
			const effectiveTaxRate = totalSubtotal > 0 ? (totalTax / totalSubtotal) * 100 : 0;

			// 9. Guardar valores anteriores para el response
			const oldVat = Number(invoice.vat) || 0;
			const oldTotal = Number(invoice.total_invoice_currency) || 0;

			// 10. Actualizar factura
			await queryRunner.manager.update(Invoice, invoiceId, {
				vat: Number(totalTax.toFixed(2)),
				total_invoice_currency: Number(totalAmount.toFixed(2)),
				tax_rate: Number(effectiveTaxRate.toFixed(2)),
			});

			await queryRunner.commitTransaction();

			this.logger.log(
				`✅ Factura ${invoiceId} recalculada: ${items.length} items, ` +
					`VAT ${oldVat} → ${totalTax.toFixed(2)}, ` +
					`Total ${oldTotal} → ${totalAmount.toFixed(2)}`
			);

			return {
				success: true,
				message: `Impuestos recalculados exitosamente para ${items.length} items`,
				invoice_id: invoiceId,
				items_updated: items.length,
				old_vat: oldVat,
				new_vat: Number(totalTax.toFixed(2)),
				old_total: oldTotal,
				new_total: Number(totalAmount.toFixed(2)),
				retentions_applied: {
					reteica: retentions.reteica > 0 ? retentions.reteica : undefined,
					retefuente: retentions.retefuente > 0 ? retentions.retefuente : undefined,
					reteiva: retentions.reteiva > 0 ? retentions.reteiva : undefined,
				},
			};
		} catch (error) {
			await queryRunner.rollbackTransaction();
			this.logger.error(`❌ Error recalculando impuestos para factura ${invoiceId}: ${error.message}`);
			throw error;
		} finally {
			await queryRunner.release();
		}
	}

	/**
	 * Recalcula impuestos de múltiples facturas en batch
	 */
	async recalculateTaxesBatch(dto: RecalculateTaxesBatchDto): Promise<RecalculateTaxesBatchResponseDto> {
		const { invoice_ids } = dto;

		this.logger.log(`🔄 Iniciando recálculo batch de ${invoice_ids.length} facturas`);

		const results: RecalculateTaxesResponseDto[] = [];
		const errors: Array<{ invoice_id: string; error: string }> = [];
		let successful = 0;
		let failed = 0;

		for (const invoiceId of invoice_ids) {
			try {
				const result = await this.recalculateInvoiceTaxes(invoiceId);
				results.push(result);
				successful++;
			} catch (error) {
				this.logger.error(`Error en factura ${invoiceId}: ${error.message}`);
				errors.push({
					invoice_id: invoiceId,
					error: error.message,
				});
				failed++;
			}
		}

		this.logger.log(`✅ Recálculo batch completado: ${successful} exitosas, ${failed} fallidas`);

		return {
			success: failed === 0,
			message: `Procesadas ${invoice_ids.length} facturas: ${successful} exitosas, ${failed} fallidas`,
			total_processed: invoice_ids.length,
			successful,
			failed,
			results,
			errors: errors.length > 0 ? errors : undefined,
		};
	}
}
