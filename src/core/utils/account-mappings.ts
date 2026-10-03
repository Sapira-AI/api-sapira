/**
 * Las 5 cuentas del asiento (`company_account_mappings`, M2). Fuente única del criterio "cuentas completas" que usan el árbol de
 * Configuración (`accounts_complete`), la Compañía 360 (`complete`) e Ingresos (excepción `no_account_mapping`).
 */
export const ACCOUNT_MAPPING_KEYS = ['receivable', 'deferred', 'unbilled', 'revenue', 'fx_difference'] as const;
export type AccountMappingKey = (typeof ACCOUNT_MAPPING_KEYS)[number];

/** Columnas de cada cuenta en `company_account_mappings`. */
export const ACCOUNT_MAPPING_COLUMNS: Record<AccountMappingKey, { code: string; name: string; external: string }> = {
	receivable: { code: 'receivable_account_code', name: 'receivable_account_name', external: 'external_receivable_code' },
	deferred: { code: 'deferred_account_code', name: 'deferred_account_name', external: 'external_deferred_code' },
	unbilled: { code: 'unbilled_account_code', name: 'unbilled_account_name', external: 'external_unbilled_code' },
	revenue: { code: 'revenue_account_code', name: 'revenue_account_name', external: 'external_revenue_code' },
	fx_difference: { code: 'fx_difference_account_code', name: 'fx_difference_account_name', external: 'external_fx_difference_code' },
};

/** Nombre en español de cada cuenta (etiqueta y nombre por defecto cuando la fila no trae uno). */
export const ACCOUNT_MAPPING_LABELS: Record<AccountMappingKey, string> = {
	receivable: 'Cuentas por cobrar',
	deferred: 'Ingresos diferidos',
	unbilled: 'Ingresos por facturar',
	revenue: 'Ingresos',
	fx_difference: 'Diferencia de cambio',
};

/** Defaults en inglés de la tabla (`DEFAULT 'Revenue'`, …) → español al leer. Un nombre propio del holding se respeta tal cual. */
const ENGLISH_DEFAULT_NAMES: Record<string, string> = {
	revenue: 'Ingresos',
	'deferred revenue': 'Ingresos diferidos',
	'unbilled revenue (contract asset)': 'Ingresos por facturar',
	'unbilled revenue': 'Ingresos por facturar',
};

/** Nombre de cuenta para mostrar: vacío → `null`; default en inglés de la tabla → español. */
export function localizeAccountName(value: unknown): string | null {
	if (typeof value !== 'string' || value.trim() === '') return null;

	return ENGLISH_DEFAULT_NAMES[value.trim().toLowerCase()] ?? value;
}

/**
 * SQL booleano: la fila `alias` de `company_account_mappings` existe y tiene las 5 cuentas con código y nombre. Con `LEFT JOIN`, una
 * compañía sin fila da `false`.
 */
export function accountsCompleteSql(alias: string): string {
	const filled = (column: string) => `NULLIF(btrim(${alias}.${column}), '') IS NOT NULL`;

	return `(${alias}.id IS NOT NULL AND ${ACCOUNT_MAPPING_KEYS.map((key) =>
		[filled(ACCOUNT_MAPPING_COLUMNS[key].code), filled(ACCOUNT_MAPPING_COLUMNS[key].name)].join(' AND ')
	).join(' AND ')})`;
}
