/**
 * Utilidades de transformación de datos de Salesforce a Sapira
 */

/**
 * Transform Salesforce billing method to Sapira billing method
 * Prepago -> Anticipado, Postpago -> Vencido, default -> Anticipado
 */
export function transformBillingMethod(formaDepago?: string): 'Anticipado' | 'Vencido' {
	if (!formaDepago) return 'Anticipado';
	if (formaDepago === 'Prepago') return 'Anticipado';
	if (formaDepago === 'Postpago') return 'Vencido';
	return 'Anticipado';
}

/**
 * Determine if line item is recurring based on Recurrencia__c field
 * If starts with "Recurrente" -> true, if "One-Shot" -> false
 */
export function isRecurring(recurrencia?: string): boolean {
	if (!recurrencia) return false;
	return recurrencia.toLowerCase().startsWith('recurrente');
}

/**
 * Calculate discount percentage from ListPrice and UnitPrice
 * Since Discount field doesn't exist, we derive it from prices
 */
export function calculateDiscountPercentage(listPrice?: number, unitPrice?: number): number | null {
	if (!listPrice || !unitPrice || listPrice === 0) return null;
	if (unitPrice >= listPrice) return null; // No discount
	const discountPercentage = ((listPrice - unitPrice) / listPrice) * 100;
	return Math.round(discountPercentage * 100) / 100; // Round to 2 decimals
}

/**
 * Determine discount type based on whether there's a discount
 */
export function getDiscountType(listPrice?: number, unitPrice?: number): 'Porcentaje' | undefined {
	const discount = calculateDiscountPercentage(listPrice, unitPrice);
	if (discount != null && discount > 0) return 'Porcentaje';
	return undefined;
}

/**
 * Format date from ISO format to dd-mm-yyyy
 */
export function formatDateToDDMMYYYY(isoDate?: string): string | null {
	if (!isoDate) return null;
	try {
		const date = new Date(isoDate);
		const day = String(date.getDate()).padStart(2, '0');
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const year = date.getFullYear();
		return `${day}-${month}-${year}`;
	} catch {
		return null;
	}
}

/**
 * Convert ISO 3166-1 alpha-2 country code to full country name
 */
const COUNTRY_CODES: Record<string, string> = {
	CL: 'Chile',
	AR: 'Argentina',
	PE: 'Perú',
	CO: 'Colombia',
	MX: 'México',
	BR: 'Brasil',
	US: 'Estados Unidos',
	ES: 'España',
	// Agregar más según sea necesario
};

export function isoToCountryName(isoCode: string | null | undefined): string | null {
	if (!isoCode) return null;
	const upperCode = isoCode.toUpperCase();
	return COUNTRY_CODES[upperCode] || isoCode; // fallback al código si no se encuentra
}

/**
 * Build custom_fields JSON object for quote_items
 * Maps Salesforce pricing model levels 3-5 and other custom fields
 */
export function buildCustomFields(lineItem: any, priceListType?: string | null): Record<string, any> | null {
	const customFields: Record<string, any> = {};

	// Nivel 3: Fuente de dato / unidad
	if (lineItem.Fuente_de_unidad__c) {
		customFields.fuente_de_unidad = lineItem.Fuente_de_unidad__c;
	}

	// Nivel 4: Fuente de optimizaciones
	if (lineItem.Fuente_Optimizaciones__c) {
		customFields.fuente_optimizaciones = lineItem.Fuente_Optimizaciones__c;
	}

	// Tipo de lista de precios (desde Account.Lista_de_Precio__r.Tipo__c)
	if (priceListType) {
		customFields.price_list_type = priceListType;
	}

	return Object.keys(customFields).length > 0 ? customFields : null;
}

/**
 * Generar número de cliente desde Salesforce Account ID
 */
export function generateClientNumber(accountId: string, salesforceApiId?: string): string {
	return salesforceApiId || accountId;
}

/**
 * Limpiar y formatear dirección
 */
export function formatAddress(street?: string, city?: string, state?: string, postalCode?: string, country?: string): string | null {
	const parts = [street, city, state, postalCode, country].filter(Boolean);
	return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Transform Salesforce boolean-like fields to actual boolean
 * Handles: 'si', 'sí', 'yes', 'true', true
 */
export function transformToBoolean(value: any): boolean {
	if (value === null || value === undefined) return false;
	if (typeof value === 'boolean') return value;
	return ['si', 'sí', 'yes', 'true'].includes(String(value).toLowerCase().trim());
}

/**
 * Calculate term_months from start and end dates
 * If dates not available, returns 12 for recurring, 1 for one-shot
 */
export function calculateTermMonths(startDate?: string, endDate?: string, isRecurring?: boolean): number {
	if (startDate && endDate) {
		const start = new Date(startDate);
		const end = new Date(endDate);
		const diffTime = Math.abs(end.getTime() - start.getTime());
		const diffMonths = Math.ceil(diffTime / (1000 * 60 * 60 * 24 * 30));
		return diffMonths > 0 ? diffMonths : isRecurring ? 12 : 1;
	}
	return isRecurring ? 12 : 1;
}

/**
 * Parse Salesforce date string to Date object in local timezone
 * Evita problemas de timezone donde "2026-05-31" se muestra como "2026-05-30"
 * @param dateStr - Fecha en formato "YYYY-MM-DD" o "YYYY-MM-DDTHH:mm:ss.sssZ"
 * @returns Date object en zona horaria local, o null si no hay fecha
 */
export function parseSalesforceDate(dateStr: string | null | undefined): Date | null {
	if (!dateStr) return null;

	// Extraer solo la parte de fecha (YYYY-MM-DD)
	const datePart = dateStr.split('T')[0];
	const [year, month, day] = datePart.split('-').map(Number);

	// Crear Date en zona horaria local (no UTC)
	// month - 1 porque los meses en JS son 0-indexed
	return new Date(year, month - 1, day);
}
