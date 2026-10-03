import { isLegacyPermissionCode, SUPER_ADMIN_ONLY_PERMISSION_CODES } from '@/guards/permission-codes';

/** Matriz módulo × Ver/Editar de la pantalla Roles y permisos (spec §1.4, D2). Orden = orden en pantalla. */
export const PERMISSION_MODULES: { key: string; label: string; view: string | null; edit: string | null; note?: string }[] = [
	{ key: 'dashboard', label: 'Dashboard', view: 'VIEW_DASHBOARD', edit: 'EDIT_DASHBOARD' },
	{ key: 'clientes', label: 'Clientes', view: 'VIEW_CLIENTES', edit: 'EDIT_CLIENTES' },
	{ key: 'cotizaciones', label: 'Cotizaciones', view: 'VIEW_COTIZACIONES', edit: 'EDIT_COTIZACIONES' },
	{ key: 'contratos', label: 'Contratos', view: 'VIEW_CONTRATOS', edit: 'EDIT_CONTRATOS' },
	{ key: 'precios', label: 'Precios y productos', view: null, edit: null, note: 'Usan Contratos (VIEW/EDIT_CONTRATOS)' },
	{ key: 'facturacion', label: 'Facturación', view: 'VIEW_FACTURACION', edit: 'EDIT_FACTURACION' },
	{ key: 'revenue', label: 'Ingresos y Métricas', view: 'VIEW_REVENUE', edit: 'EDIT_REVENUE' },
	{ key: 'reportes', label: 'Reportes', view: 'VIEW_REPORTES', edit: 'EDIT_REPORTES' },
	{ key: 'agentes', label: 'Agentes IA', view: 'VIEW_AGENTES_IA', edit: 'EDIT_AGENTES_IA' },
	{ key: 'integraciones', label: 'Integraciones', view: 'VIEW_INTEGRACIONES', edit: 'EDIT_INTEGRACIONES' },
	{ key: 'configuracion', label: 'Configuración', view: 'VIEW_CONFIGURACION', edit: 'EDIT_CONFIGURACION' },
];

/** Permisos de acción (fuera de la matriz). */
export const SPECIAL_PERMISSIONS: { code: string; label: string }[] = [{ code: 'CLOSE_PERIODS', label: 'Cerrar y reabrir períodos contables' }];

/** Etiquetas de los internos (solo super admin los ve). */
export const INTERNAL_PERMISSION_LABELS: Record<string, string> = {
	ALL_PERMISSIONS: 'Acceso completo (comodín)',
	ADMIN_FULL_ACCESS: 'Acceso completo de administrador (heredado)',
	VIEW_LAB: 'Ver el laboratorio (interno)',
	VIEW_DOCUMENTACION: 'Ver documentación interna',
};

/** Códigos que un usuario puede ver y otorgar en el selector. */
export function isGrantable(code: string, isSuperAdmin: boolean): boolean {
	if (isLegacyPermissionCode(code)) return false;
	if (SUPER_ADMIN_ONLY_PERMISSION_CODES.includes(code)) return isSuperAdmin;

	return true;
}

/** Códigos visibles en la matriz + especiales (sin internos ni heredados), presentes en el catálogo. */
export function visibleCodes(catalog: ReadonlySet<string>): string[] {
	const codes = [
		...PERMISSION_MODULES.flatMap((module) => [module.view, module.edit]).filter((code): code is string => !!code),
		...SPECIAL_PERMISSIONS.map((permission) => permission.code),
	];

	return codes.filter((code) => catalog.has(code));
}

/** Línea de capacidad del correo de invitación. */
export interface RoleCapability {
	text: string;
}

export const FULL_ACCESS_CAPABILITY = 'Acceso completo a todos los módulos';

/**
 * Qué puede hacer un rol, en lenguaje de usuario, a partir de sus códigos reales (`role_permissions`): por módulo de la matriz
 * VIEW → "Ver {módulo}", EDIT → "Ver y editar {módulo}"; `CLOSE_PERIODS` con su etiqueta. Omite internos, comodines y heredados.
 * `ALL_PERMISSIONS` o todos los códigos de la matriz y especiales → una sola línea de acceso completo.
 */
export function roleCapabilities(codes: Iterable<string>): RoleCapability[] {
	const owned = new Set(codes);
	const all = [
		...PERMISSION_MODULES.flatMap((module) => [module.view, module.edit]).filter((code): code is string => !!code),
		...SPECIAL_PERMISSIONS.map((permission) => permission.code),
	];

	if (owned.has('ALL_PERMISSIONS') || all.every((code) => owned.has(code))) return [{ text: FULL_ACCESS_CAPABILITY }];
	const capabilities: RoleCapability[] = [];

	for (const module of PERMISSION_MODULES) {
		const canEdit = !!module.edit && owned.has(module.edit);
		const canView = !!module.view && owned.has(module.view);

		if (!canEdit && !canView) continue;
		capabilities.push({ text: `${canEdit ? 'Ver y editar' : 'Ver'} ${module.label}` });
	}
	for (const special of SPECIAL_PERMISSIONS) if (owned.has(special.code)) capabilities.push({ text: special.label });

	return capabilities;
}
