/**
 * VATs genéricos utilizados para facturación de exportación
 * Estos VATs se usan para múltiples clientes y NO deben usarse
 * como identificador único para búsquedas.
 *
 * Para estos casos, siempre se debe buscar por la combinación
 * VAT + odoo_partner_id
 */
export const GENERIC_EXPORT_VATS = [
	'5555555-5', // Chile - VAT genérico para exportación
	'55555555', // Chile - Variante sin guión
	'555555555', // Genérico internacional
	'00000000-0', // Chile - VAT genérico alternativo
	'99999999-9', // Chile - VAT genérico alternativo
	'EXPORT', // Genérico textual
	'EXPORTACION', // Genérico textual español
	'XEXX010101000',
];

/**
 * Verifica si un VAT es genérico (usado para exportaciones)
 * @param vat - VAT a verificar
 * @returns true si el VAT es genérico
 */
export function isGenericExportVat(vat: string | null | undefined): boolean {
	if (!vat) {
		return false;
	}

	const normalizedVat = vat.trim().toUpperCase();

	return GENERIC_EXPORT_VATS.some((genericVat) => normalizedVat === genericVat.toUpperCase());
}
