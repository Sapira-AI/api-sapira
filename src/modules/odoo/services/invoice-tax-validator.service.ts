import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { InvoiceItem } from '@/modules/invoices/entities/invoice-item.entity';
import { Invoice } from '@/modules/invoices/entities/invoice.entity';

import { OdooConnection } from '../entities/odoo-connection.entity';
import { OdooProvider } from '../odoo.provider';

import { AppliedTaxMapping, TaxMappingService } from './tax-mapping.service';

export interface TaxMappingValidationLine {
	line_number: number;
	product_id: number;
	product_name: string;
	product_sale_taxes: number[];
	fiscal_position_mappings: AppliedTaxMapping[];
	calculated_tax_ids: number[];
	odoo_tax_ids: number[];
	matches: boolean;
	missing_in_calculation: number[];
	extra_in_calculation: number[];
}

export interface TaxMappingValidationResult {
	odoo_invoice_id: number;
	odoo_invoice_name: string;
	partner_id: number;
	partner_name: string;
	fiscal_position_id: number | null;
	fiscal_position_name: string | null;
	company_id: number;
	company_name: string;
	matches: boolean;
	lines: TaxMappingValidationLine[];
	summary: {
		total_lines: number;
		matching_lines: number;
		mismatching_lines: number;
		match_percentage: number;
	};
}

export interface TaxValidationLine {
	line_number: number;
	product_id: number;
	product_name: string;
	sapira_tax_ids: number[];
	odoo_tax_ids: number[];
	matches: boolean;
	missing_in_odoo: number[];
	extra_in_odoo: number[];
}

export interface InvoiceTaxValidationResult {
	sapira_invoice_id: string;
	sapira_invoice_number: string;
	odoo_invoice_id: number | null;
	odoo_invoice_name: string | null;
	matches: boolean;
	lines: TaxValidationLine[];
	summary: {
		total_lines: number;
		matching_lines: number;
		mismatching_lines: number;
	};
}

@Injectable()
export class InvoiceTaxValidatorService {
	private readonly logger = new Logger(InvoiceTaxValidatorService.name);

	constructor(
		private readonly odooProvider: OdooProvider,
		@InjectRepository(OdooConnection)
		private readonly odooConnectionRepository: Repository<OdooConnection>,
		@InjectRepository(Invoice)
		private readonly invoiceRepository: Repository<Invoice>,
		@InjectRepository(InvoiceItem)
		private readonly invoiceItemRepository: Repository<InvoiceItem>,
		private readonly taxMappingService: TaxMappingService
	) {}

	async validateInvoiceTaxes(sapiraInvoiceId: string, holdingId: string): Promise<InvoiceTaxValidationResult> {
		try {
			this.logger.log(`🔍 Validando impuestos de factura Sapira ${sapiraInvoiceId}`);

			// 1. Obtener factura de Sapira
			const sapiraInvoice = await this.invoiceRepository.findOne({
				where: { id: sapiraInvoiceId },
			});

			if (!sapiraInvoice) {
				throw new Error(`Factura Sapira ${sapiraInvoiceId} no encontrada`);
			}

			if (!sapiraInvoice.odoo_invoice_id) {
				throw new Error(`Factura Sapira ${sapiraInvoice.invoice_number} no tiene odoo_invoice_id`);
			}

			// 2. Obtener items de la factura
			const sapiraItems = await this.invoiceItemRepository.find({
				where: { invoice_id: sapiraInvoiceId },
				order: { created_at: 'ASC' },
			});

			// 2. Obtener conexión de Odoo
			const connection = await this.getOdooConnectionByHoldingId(holdingId);
			if (!connection) {
				throw new Error('No se encontró una conexión activa de Odoo para este holding');
			}

			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			// 3. Obtener factura de Odoo con sus líneas
			const odooInvoiceData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move',
				'read',
				[[sapiraInvoice.odoo_invoice_id]],
				{
					fields: ['id', 'name', 'invoice_line_ids'],
				},
			]);

			if (!odooInvoiceData || odooInvoiceData.length === 0) {
				throw new Error(`Factura Odoo ${sapiraInvoice.odoo_invoice_id} no encontrada`);
			}

			const odooInvoice = odooInvoiceData[0];
			const odooLineIds = Array.isArray(odooInvoice.invoice_line_ids) ? odooInvoice.invoice_line_ids : [];

			// 4. Obtener líneas de factura de Odoo
			const odooLinesData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move.line',
				'read',
				[odooLineIds],
				{
					fields: ['id', 'product_id', 'name', 'tax_ids', 'display_type'],
				},
			]);

			// Filtrar solo líneas de producto (excluir líneas de sección, nota, etc.)
			const odooProductLines = odooLinesData.filter((line: any) => !line.display_type && line.product_id);

			// 5. Comparar líneas
			const validationLines: TaxValidationLine[] = [];
			let matchingLines = 0;

			for (let i = 0; i < sapiraItems.length; i++) {
				const sapiraItem = sapiraItems[i];
				const odooLine = odooProductLines[i];

				if (!odooLine) {
					this.logger.warn(`⚠️ Línea ${i + 1} de Sapira no tiene correspondencia en Odoo`);
					continue;
				}

				// En Sapira solo guardamos un tax_id por item, pero en Odoo puede haber múltiples
				// Para validar correctamente, necesitamos obtener todos los tax_ids que se aplicaron
				const sapiraTaxIds = sapiraItem.odoo_tax_id ? [sapiraItem.odoo_tax_id] : [];
				const odooTaxIds = Array.isArray(odooLine.tax_ids) ? odooLine.tax_ids : [];

				const sapiraTaxIdsSet = new Set(sapiraTaxIds);
				const odooTaxIdsSet = new Set(odooTaxIds);

				const missingInOdoo = sapiraTaxIds.filter((id: number) => !odooTaxIdsSet.has(id));
				const extraInOdoo = odooTaxIds.filter((id: number) => !sapiraTaxIdsSet.has(id));

				const matches = missingInOdoo.length === 0 && extraInOdoo.length === 0;

				if (matches) {
					matchingLines++;
				}

				validationLines.push({
					line_number: i + 1,
					product_id: Array.isArray(odooLine.product_id) ? odooLine.product_id[0] : odooLine.product_id,
					product_name: Array.isArray(odooLine.product_id) ? odooLine.product_id[1] : odooLine.name,
					sapira_tax_ids: sapiraTaxIds,
					odoo_tax_ids: odooTaxIds,
					matches,
					missing_in_odoo: missingInOdoo,
					extra_in_odoo: extraInOdoo,
				});
			}

			const allMatch = matchingLines === validationLines.length;

			this.logger.log(`${allMatch ? '✅' : '⚠️'} Validación completada: ${matchingLines}/${validationLines.length} líneas coinciden`);

			return {
				sapira_invoice_id: sapiraInvoiceId,
				sapira_invoice_number: sapiraInvoice.invoice_number,
				odoo_invoice_id: sapiraInvoice.odoo_invoice_id,
				odoo_invoice_name: odooInvoice.name,
				matches: allMatch,
				lines: validationLines,
				summary: {
					total_lines: validationLines.length,
					matching_lines: matchingLines,
					mismatching_lines: validationLines.length - matchingLines,
				},
			};
		} catch (error) {
			this.logger.error(`❌ Error validando impuestos de factura: ${error.message}`, error.stack);
			throw error;
		}
	}

	async validateTaxMappingLogic(odooInvoiceId: number, holdingId: string): Promise<TaxMappingValidationResult> {
		try {
			this.logger.log(`🔍 Validando lógica de mapeo de impuestos para factura Odoo ${odooInvoiceId}`);

			// 1. Obtener conexión de Odoo
			const connection = await this.getOdooConnectionByHoldingId(holdingId);
			if (!connection) {
				throw new Error('No se encontró una conexión activa de Odoo para este holding');
			}

			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			// 2. Obtener factura de Odoo con información completa
			const odooInvoiceData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move',
				'read',
				[[odooInvoiceId]],
				{
					fields: ['id', 'name', 'partner_id', 'fiscal_position_id', 'company_id', 'invoice_line_ids'],
				},
			]);

			if (!odooInvoiceData || odooInvoiceData.length === 0) {
				throw new Error(`Factura Odoo ${odooInvoiceId} no encontrada`);
			}

			const odooInvoice = odooInvoiceData[0];
			const partnerId = Array.isArray(odooInvoice.partner_id) ? odooInvoice.partner_id[0] : odooInvoice.partner_id;
			const partnerName = Array.isArray(odooInvoice.partner_id) ? odooInvoice.partner_id[1] : '';
			const fiscalPositionId = Array.isArray(odooInvoice.fiscal_position_id)
				? odooInvoice.fiscal_position_id[0]
				: odooInvoice.fiscal_position_id || null;
			const fiscalPositionName = Array.isArray(odooInvoice.fiscal_position_id) ? odooInvoice.fiscal_position_id[1] : null;
			const companyId = Array.isArray(odooInvoice.company_id) ? odooInvoice.company_id[0] : odooInvoice.company_id;
			const companyName = Array.isArray(odooInvoice.company_id) ? odooInvoice.company_id[1] : '';
			const odooLineIds = Array.isArray(odooInvoice.invoice_line_ids) ? odooInvoice.invoice_line_ids : [];

			this.logger.log(`📋 Factura: ${odooInvoice.name}`);
			this.logger.log(`👤 Partner: ${partnerName} (ID: ${partnerId})`);
			this.logger.log(`🏛️  Posición Fiscal: ${fiscalPositionName || 'Sin posición fiscal'} (ID: ${fiscalPositionId || 'N/A'})`);
			this.logger.log(`🏢 Compañía: ${companyName} (ID: ${companyId})`);

			// 3. Obtener líneas de factura de Odoo
			const odooLinesData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move.line',
				'read',
				[odooLineIds],
				{
					fields: ['id', 'product_id', 'name', 'tax_ids', 'display_type'],
				},
			]);

			// Filtrar solo líneas de producto (excluir líneas de sección, nota, payment_term, etc.)
			const odooProductLines = odooLinesData.filter(
				(line: any) => line.product_id && (line.display_type === 'product' || line.display_type === false)
			);

			this.logger.log(`📦 Líneas de producto: ${odooProductLines.length}`);

			// 4. Para cada línea, simular cálculo de impuestos
			const validationLines: TaxMappingValidationLine[] = [];
			let matchingLines = 0;

			for (let i = 0; i < odooProductLines.length; i++) {
				const odooLine = odooProductLines[i];
				const productId = Array.isArray(odooLine.product_id) ? odooLine.product_id[0] : odooLine.product_id;
				const productName = Array.isArray(odooLine.product_id) ? odooLine.product_id[1] : odooLine.name;
				const odooTaxIds = Array.isArray(odooLine.tax_ids) ? odooLine.tax_ids.sort((a: number, b: number) => a - b) : [];

				this.logger.debug(`\n🔍 Procesando línea ${i + 1}: Producto ${productId} (${productName})`);

				// Obtener impuestos de venta del producto
				const productSaleTaxes = await this.taxMappingService.getProductSaleTaxes(productId, companyId, holdingId);

				this.logger.debug(`  📊 Impuestos de venta del producto: [${productSaleTaxes.join(', ')}]`);

				let calculatedTaxIds: number[] = [];
				let fiscalPositionMappings: AppliedTaxMapping[] = [];

				// Aplicar mapeo de posición fiscal si existe
				if (fiscalPositionId) {
					const mappingResult = await this.taxMappingService.applyFiscalPositionMapping(productSaleTaxes, fiscalPositionId, holdingId);
					calculatedTaxIds = mappingResult.final_tax_ids.sort((a, b) => a - b);
					fiscalPositionMappings = mappingResult.mappings_applied;

					this.logger.debug(`  🔄 Mapeo de posición fiscal aplicado`);
					this.logger.debug(`  ✅ Impuestos calculados: [${calculatedTaxIds.join(', ')}]`);
				} else {
					// Sin posición fiscal, usar impuestos del producto directamente
					calculatedTaxIds = productSaleTaxes.sort((a, b) => a - b);
					this.logger.debug(`  ℹ️  Sin posición fiscal, usando impuestos del producto`);
				}

				// Comparar
				const calculatedSet = new Set(calculatedTaxIds);
				const odooSet = new Set(odooTaxIds);

				const missingInCalculation = odooTaxIds.filter((id: number) => !calculatedSet.has(id));
				const extraInCalculation = calculatedTaxIds.filter((id: number) => !odooSet.has(id));

				const matches = missingInCalculation.length === 0 && extraInCalculation.length === 0;

				if (matches) {
					matchingLines++;
					this.logger.debug(`  ✅ COINCIDE`);
				} else {
					this.logger.warn(`  ⚠️  NO COINCIDE`);
					this.logger.warn(`     Odoo: [${odooTaxIds.join(', ')}]`);
					this.logger.warn(`     Calculado: [${calculatedTaxIds.join(', ')}]`);
					if (missingInCalculation.length > 0) {
						this.logger.warn(`     Faltantes: [${missingInCalculation.join(', ')}]`);
					}
					if (extraInCalculation.length > 0) {
						this.logger.warn(`     Extras: [${extraInCalculation.join(', ')}]`);
					}
				}

				validationLines.push({
					line_number: i + 1,
					product_id: productId,
					product_name: productName,
					product_sale_taxes: productSaleTaxes,
					fiscal_position_mappings: fiscalPositionMappings,
					calculated_tax_ids: calculatedTaxIds,
					odoo_tax_ids: odooTaxIds,
					matches,
					missing_in_calculation: missingInCalculation,
					extra_in_calculation: extraInCalculation,
				});
			}

			const allMatch = matchingLines === validationLines.length;
			const matchPercentage = validationLines.length > 0 ? Math.round((matchingLines / validationLines.length) * 100) : 0;

			this.logger.log(
				`\n${allMatch ? '✅' : '⚠️'} Validación completada: ${matchingLines}/${validationLines.length} líneas coinciden (${matchPercentage}%)`
			);

			return {
				odoo_invoice_id: odooInvoiceId,
				odoo_invoice_name: odooInvoice.name,
				partner_id: partnerId,
				partner_name: partnerName,
				fiscal_position_id: fiscalPositionId,
				fiscal_position_name: fiscalPositionName,
				company_id: companyId,
				company_name: companyName,
				matches: allMatch,
				lines: validationLines,
				summary: {
					total_lines: validationLines.length,
					matching_lines: matchingLines,
					mismatching_lines: validationLines.length - matchingLines,
					match_percentage: matchPercentage,
				},
			};
		} catch (error) {
			this.logger.error(`❌ Error validando lógica de mapeo de impuestos: ${error.message}`, error.stack);
			throw error;
		}
	}

	private async getOdooConnectionByHoldingId(holdingId: string): Promise<OdooConnection | null> {
		return await this.odooConnectionRepository.findOne({
			where: {
				holding_id: holdingId,
				is_active: true,
			},
		});
	}
}
