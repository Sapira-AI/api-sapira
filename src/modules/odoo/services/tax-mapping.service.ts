import { Injectable, Logger } from '@nestjs/common';

import { FiscalPositionsService } from './fiscal-positions.service';

export interface AppliedTaxMapping {
	original_tax_id: number;
	original_tax_name: string;
	mapped_tax_id: number | null;
	mapped_tax_name: string | null;
	action: 'keep' | 'replace' | 'remove';
}

export interface TaxMappingResult {
	final_tax_ids: number[];
	mappings_applied: AppliedTaxMapping[];
	fiscal_position_id: number | null;
	fiscal_position_name: string | null;
}

@Injectable()
export class TaxMappingService {
	private readonly logger = new Logger(TaxMappingService.name);

	constructor(private readonly fiscalPositionsService: FiscalPositionsService) {}

	/**
	 * Aplica el mapeo de posición fiscal a los impuestos del producto
	 * Replica el comportamiento nativo de Odoo
	 */
	async applyFiscalPositionMapping(productTaxIds: number[], fiscalPositionId: number, holdingId: string): Promise<TaxMappingResult> {
		try {
			this.logger.log(`🔄 Aplicando mapeo de posición fiscal ${fiscalPositionId} a impuestos del producto: [${productTaxIds.join(', ')}]`);

			// Obtener la posición fiscal completa con todos sus mapeos
			const fiscalPosition = await this.fiscalPositionsService.getFiscalPositionComplete(holdingId, fiscalPositionId);

			if (!fiscalPosition) {
				this.logger.warn(`⚠️ Posición fiscal ${fiscalPositionId} no encontrada, usando impuestos del producto sin mapeo`);
				return {
					final_tax_ids: productTaxIds,
					mappings_applied: [],
					fiscal_position_id: null,
					fiscal_position_name: null,
				};
			}

			const finalTaxIds: number[] = [];
			const mappingsApplied: AppliedTaxMapping[] = [];

			// Aplicar algoritmo de mapeo para cada impuesto del producto
			for (const taxId of productTaxIds) {
				// Buscar si existe un mapeo para este impuesto
				const mapping = fiscalPosition.complete_tax_mappings.find((m) => m.tax_src_id === taxId);

				if (mapping) {
					// Existe un mapeo para este impuesto
					if (mapping.tax_dest_id !== null) {
						// Mapeo a otro impuesto (REPLACE)
						finalTaxIds.push(mapping.tax_dest_id);
						mappingsApplied.push({
							original_tax_id: taxId,
							original_tax_name: mapping.tax_src_name || '',
							mapped_tax_id: mapping.tax_dest_id,
							mapped_tax_name: mapping.tax_dest_name || '',
							action: 'replace',
						});
						this.logger.debug(`  ↪️ Tax ${taxId} (${mapping.tax_src_name}) → ${mapping.tax_dest_id} (${mapping.tax_dest_name})`);
					} else {
						// Mapeo a null (REMOVE)
						mappingsApplied.push({
							original_tax_id: taxId,
							original_tax_name: mapping.tax_src_name || '',
							mapped_tax_id: null,
							mapped_tax_name: null,
							action: 'remove',
						});
						this.logger.debug(`  ❌ Tax ${taxId} (${mapping.tax_src_name}) → eliminado`);
					}
				} else {
					// No existe mapeo, mantener el impuesto original (KEEP)
					finalTaxIds.push(taxId);
					mappingsApplied.push({
						original_tax_id: taxId,
						original_tax_name: '',
						mapped_tax_id: taxId,
						mapped_tax_name: '',
						action: 'keep',
					});
					this.logger.debug(`  ✓ Tax ${taxId} → sin mapeo, se mantiene`);
				}
			}

			// Eliminar duplicados
			const uniqueTaxIds = [...new Set(finalTaxIds)];

			this.logger.log(
				`✅ Mapeo completado. Impuestos originales: [${productTaxIds.join(', ')}] → Impuestos finales: [${uniqueTaxIds.join(', ')}]`
			);

			return {
				final_tax_ids: uniqueTaxIds,
				mappings_applied: mappingsApplied,
				fiscal_position_id: fiscalPosition.id,
				fiscal_position_name: fiscalPosition.name,
			};
		} catch (error) {
			this.logger.error(`❌ Error aplicando mapeo de posición fiscal: ${error.message}`, error.stack);
			// En caso de error, retornar impuestos originales sin mapeo
			return {
				final_tax_ids: productTaxIds,
				mappings_applied: [],
				fiscal_position_id: null,
				fiscal_position_name: null,
			};
		}
	}

	/**
	 * Obtiene solo los impuestos de venta de un producto
	 * Filtra por type_tax_use = "sale" y company_id
	 */
	async getProductSaleTaxes(productId: number, companyId: number, holdingId: string): Promise<number[]> {
		try {
			this.logger.debug(`🔍 Consultando impuestos de venta del producto ${productId} para compañía ${companyId}`);

			const connection = await this.fiscalPositionsService['getOdooConnectionByHoldingId'](holdingId);
			if (!connection) {
				throw new Error('No se encontró una conexión activa de Odoo para este holding');
			}

			const commonClient = this.fiscalPositionsService['odooProvider'].createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.fiscalPositionsService['odooProvider'].createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			// Leer el producto con sus impuestos
			const productData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'product.product',
				'read',
				[[productId]],
				{
					fields: ['taxes_id'],
				},
			]);

			if (!productData || productData.length === 0) {
				this.logger.warn(`⚠️ Producto ${productId} no encontrado`);
				return [];
			}

			const product = productData[0];
			const taxIds = Array.isArray(product.taxes_id) ? product.taxes_id : [];

			if (taxIds.length === 0) {
				this.logger.debug(`ℹ️ Producto ${productId} no tiene impuestos configurados`);
				return [];
			}

			// Consultar información de los impuestos
			const taxesData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.tax',
				'read',
				[taxIds],
				{
					fields: ['id', 'name', 'type_tax_use', 'company_id', 'active'],
				},
			]);

			// Filtrar solo impuestos de venta, activos y de la compañía correcta
			const saleTaxIds = taxesData
				.filter((tax: any) => {
					const taxCompanyId = Array.isArray(tax.company_id) ? tax.company_id[0] : tax.company_id;
					return tax.type_tax_use === 'sale' && tax.active && taxCompanyId === companyId;
				})
				.map((tax: any) => tax.id);

			this.logger.log(
				`✅ Producto ${productId}: ${taxIds.length} impuestos totales → ${saleTaxIds.length} impuestos de venta: [${saleTaxIds.join(', ')}]`
			);

			return saleTaxIds;
		} catch (error) {
			this.logger.error(`❌ Error consultando impuestos del producto ${productId}: ${error.message}`, error.stack);
			return [];
		}
	}
}
