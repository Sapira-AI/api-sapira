/**
 * Utilidades para comparación de valores en integraciones de Odoo
 */

/**
 * Normaliza valores "vacíos" a null para comparación consistente
 */
function normalizeEmpty(val: any): any | null {
	if (val === null || val === undefined || val === false || val === '' || val === 'false') {
		return null;
	}
	return val;
}

/**
 * Compara dos valores normalizando tipos y formatos
 * Maneja casos especiales como:
 * - Valores vacíos (null, undefined, false, string vacío)
 * - Fechas (ignora hora y timezone)
 * - Números (con tolerancia para decimales)
 * - Strings (case-insensitive y trimmed)
 */
export function areValuesEqual(value1: any, value2: any): boolean {
	const norm1 = normalizeEmpty(value1);
	const norm2 = normalizeEmpty(value2);

	// Ambos son valores "vacíos"
	if (norm1 === null && norm2 === null) {
		return true;
	}

	// Uno es vacío y el otro no
	if (norm1 === null || norm2 === null) {
		return false;
	}

	// Comparar fechas - normalizar a solo fecha (YYYY-MM-DD) sin hora
	const datePattern = /^\d{4}-\d{2}-\d{2}/;
	const isDate1 = value1 instanceof Date || (typeof value1 === 'string' && datePattern.test(value1));
	const isDate2 = value2 instanceof Date || (typeof value2 === 'string' && datePattern.test(value2));

	if (isDate1 && isDate2) {
		try {
			const date1 = new Date(value1);
			const date2 = new Date(value2);

			// Comparar solo año, mes y día (ignorar hora y timezone)
			const dateStr1 = `${date1.getUTCFullYear()}-${String(date1.getUTCMonth() + 1).padStart(2, '0')}-${String(date1.getUTCDate()).padStart(2, '0')}`;
			const dateStr2 = `${date2.getUTCFullYear()}-${String(date2.getUTCMonth() + 1).padStart(2, '0')}-${String(date2.getUTCDate()).padStart(2, '0')}`;

			return dateStr1 === dateStr2;
		} catch {
			// Si falla el parseo de fecha, continuar con otras comparaciones
		}
	}

	// Comparar números (incluyendo strings que son números)
	const num1 = Number(norm1);
	const num2 = Number(norm2);
	if (!isNaN(num1) && !isNaN(num2)) {
		// Comparar con tolerancia para decimales
		return Math.abs(num1 - num2) < 0.01;
	}

	// Comparar objetos y arrays
	if (typeof norm1 === 'object' && typeof norm2 === 'object') {
		return JSON.stringify(norm1) === JSON.stringify(norm2);
	}

	// Comparar strings (case-insensitive y trimmed)
	if (typeof norm1 === 'string' && typeof norm2 === 'string') {
		return norm1.trim().toLowerCase() === norm2.trim().toLowerCase();
	}

	// Comparación directa
	return norm1 === norm2;
}

/**
 * Normaliza un valor para comparación (convierte a string vacío si es null/undefined/false)
 */
export function normalizeValue(value: any): string {
	if (value === null || value === undefined || value === false || value === 'false') {
		return '';
	}
	return String(value).trim().toLowerCase();
}
