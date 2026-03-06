import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

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
		const invoices = await this.invoiceRepository.findByIds(invoiceIds);

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
		try {
			// Intentar obtener tipo de cambio
			const exchangeRate = await this.exchangeRatesService.getExchangeRateWithFallback(
				invoice.contract_currency,
				newCurrency,
				invoice.invoice_date
			);

			if (!dryRun) {
				// Actualizar factura con FX
				await this.invoiceRepository.update(invoice.id, {
					invoice_currency: newCurrency,
					amount_invoice_currency: Number(invoice.amount_contract_currency) * exchangeRate.rate,
					fx_contract_to_invoice: exchangeRate.rate,
					total_invoice_currency: null, // Se calculará desde items
					vat: null, // Se recalculará
				});

				// Actualizar items con FX
				const items = await this.invoiceItemRepository.find({ where: { invoice_id: invoice.id } });

				for (const item of items) {
					await this.invoiceItemRepository.update(item.id, {
						invoice_currency: newCurrency,
						unit_price_invoice_currency: Number(item.unit_price_contract_currency) * exchangeRate.rate,
						subtotal_invoice_currency: Number(item.subtotal_contract_currency) * exchangeRate.rate,
						tax_amount_invoice_currency: item.tax_amount_contract_currency
							? Number(item.tax_amount_contract_currency) * exchangeRate.rate
							: null,
						total_invoice_currency: Number(item.total_contract_currency) * exchangeRate.rate,
						fx_contract_to_invoice: exchangeRate.rate,
					});
				}
			}

			if (exchangeRate.is_fallback) {
				const usedDate = exchangeRate.rate_date.toISOString().split('T')[0];
				const requestedDate = invoice.invoice_date.toISOString().split('T')[0];

				this.logger.debug(`Factura ${invoice.id}: FX fallback usado (${usedDate} en lugar de ${requestedDate}), rate: ${exchangeRate.rate}`);

				return {
					type: 'FALLBACK',
					message: `Tipo de cambio de ${usedDate} usado para factura ${invoice.invoice_number || invoice.id} (solicitado: ${requestedDate})`,
					fallbackInfo: {
						usedDate,
						requestedDate,
						rate: exchangeRate.rate,
					},
				};
			}

			this.logger.debug(`Factura ${invoice.id}: FX automático aplicado, rate: ${exchangeRate.rate}`);

			return { type: 'AUTOMATIC' };
		} catch (error) {
			// No hay tipo de cambio disponible
			this.logger.warn(`No hay tipo de cambio disponible para ${invoice.contract_currency}/${newCurrency} en ${invoice.invoice_date}`);

			if (!dryRun) {
				// Actualizar sin FX (valores en NULL)
				await this.invoiceRepository.update(invoice.id, {
					invoice_currency: newCurrency,
					amount_invoice_currency: null,
					total_invoice_currency: null,
					vat: null,
					fx_contract_to_invoice: null,
				});

				// Actualizar items sin FX
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

			const requestedDate = invoice.invoice_date.toISOString().split('T')[0];

			return {
				type: 'MISSING',
				message: `No hay tipo de cambio disponible para ${invoice.contract_currency}/${newCurrency}. Deberá ingresar el tipo de cambio manualmente.`,
				missingInfo: {
					fromCurrency: invoice.contract_currency,
					toCurrency: newCurrency,
					requestedDate,
				},
			};
		}
	}
}
