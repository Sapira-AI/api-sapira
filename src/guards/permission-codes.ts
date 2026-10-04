/**
 * Códigos del catálogo `permissions` que la API reconoce (spec Configuración v2, D2). El catálogo vive en la base; esto solo nombra los
 * que tienen reglas especiales y la frase con la que se arma el 403 ("No tienes permiso para … · pídeselo a un administrador", D3).
 */

/** Comodín de los roles de cliente: cubre todo salvo los permisos internos. */
export const ALL_PERMISSIONS = 'ALL_PERMISSIONS';

/** Permisos internos de Sapira: ni el comodín los destapa; solo super admin u otorgamiento explícito de un super admin. */
export const INTERNAL_PERMISSION_CODES: readonly string[] = ['VIEW_LAB', 'VIEW_DOCUMENTACION'];

/** Permisos que la UI de roles no muestra a quien no es super admin (internos, comodines). */
export const SUPER_ADMIN_ONLY_PERMISSION_CODES: readonly string[] = [...INTERNAL_PERMISSION_CODES, ALL_PERMISSIONS, 'ADMIN_FULL_ACCESS'];

/** Códigos heredados que no se ofrecen en el selector (D2). */
export const isLegacyPermissionCode = (code: string): boolean =>
	code.startsWith('MANAGE_') || code === 'VIEW_REPORTS' || code.endsWith('_FINANCIAL_DATA');

export const PERMISSION_CODES = {
	viewSettings: 'VIEW_CONFIGURACION',
	editSettings: 'EDIT_CONFIGURACION',
	closePeriods: 'CLOSE_PERIODS',
	viewContracts: 'VIEW_CONTRATOS',
	editContracts: 'EDIT_CONTRATOS',
	viewIntegrations: 'VIEW_INTEGRACIONES',
	editIntegrations: 'EDIT_INTEGRACIONES',
} as const;

/** Acción en infinitivo para el mensaje 403. */
const ACTION_LABELS: Record<string, string> = {
	VIEW_CONFIGURACION: 'ver la configuración',
	EDIT_CONFIGURACION: 'editar la configuración',
	CLOSE_PERIODS: 'cerrar y reabrir períodos contables',
	VIEW_CONTRATOS: 'ver contratos y precios',
	EDIT_CONTRATOS: 'editar contratos y precios',
	VIEW_CLIENTES: 'ver clientes',
	EDIT_CLIENTES: 'editar clientes',
	VIEW_COTIZACIONES: 'ver cotizaciones',
	EDIT_COTIZACIONES: 'editar cotizaciones',
	VIEW_FACTURACION: 'ver la facturación',
	EDIT_FACTURACION: 'editar la facturación',
	VIEW_REVENUE: 'ver ingresos y métricas',
	EDIT_REVENUE: 'editar ingresos y métricas',
	VIEW_INTEGRACIONES: 'ver las integraciones',
	EDIT_INTEGRACIONES: 'configurar las integraciones',
};

export function forbiddenMessage(codes: readonly string[]): string {
	const action = ACTION_LABELS[codes[0]] ?? 'realizar esta acción';

	return `No tienes permiso para ${action} · pídeselo a un administrador`;
}
