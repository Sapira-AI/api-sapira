import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { ExchangeRatesService } from '../banco-central/services/exchange-rates.service';

import {
	BulkUpdateCurrencyResponseDto,
	BulkUpdateErrorDto,
	BulkUpdateSummaryDto,
	BulkUpdateWarningDto,
} from './dtos/bulk-update-currency-response.dto';
import { BulkUpdateCurrencyDto } from './dtos/bulk-update-currency.dto';
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
		private readonly exchangeRatesService: ExchangeRatesService
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
}
