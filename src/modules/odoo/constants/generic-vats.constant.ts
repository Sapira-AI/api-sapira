/**
 * @deprecated Este array ya no se usa directamente.
 * Los VATs genéricos ahora se almacenan en la tabla `generic_export_vats` de la base de datos.
 * Usar el servicio `GenericVatsService` para verificar si un VAT es genérico.
 *
 * Este array se mantiene solo como referencia histórica y fallback de emergencia.
 */
export const GENERIC_EXPORT_VATS_FALLBACK = [
	'5555555-5', // Chile - VAT genérico para exportación
	'55555555', // Chile - Variante sin guión
	'555555555', // Genérico internacional
	'00000000-0', // Chile - VAT genérico alternativo
	'99999999-9', // Chile - VAT genérico alternativo
	'EXPORT', // Genérico textual
	'EXPORTACION', // Genérico textual español
	'XEXX010101000', // México - VAT genérico para exportación
];

/**
 * @deprecated Esta función ya no se usa directamente.
 * Usar `GenericVatsService.isGenericExportVat()` en su lugar.
 *
 * Función de fallback para verificar si un VAT es genérico (usado para exportaciones)
 * @param vat - VAT a verificar
 * @returns true si el VAT es genérico
 */
export function isGenericExportVatFallback(vat: string | null | undefined): boolean {
	if (!vat) {
		return false;
	}

	const normalizedVat = vat.trim().toUpperCase();

	return GENERIC_EXPORT_VATS_FALLBACK.some((genericVat) => normalizedVat === genericVat.toUpperCase());
}
