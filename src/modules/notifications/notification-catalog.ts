/**
 * Catálogo único de tipos de notificación (Notificaciones v2, `docs/v2-rediseno/contrato-api-notificaciones.md` §1). Una entrada por tipo:
 * etiqueta, módulo, ícono (nombre lucide), gravedad por defecto, si se suscribe por rol, roles por defecto (D3 + ajustes de Domi 03-10) y
 * los textos "Qué pasó" / "Qué hacer" (+ "Qué hacemos nosotros") que el detalle usa cuando el productor no trae los suyos.
 * Puro: sin Nest ni base. Lo leen el servicio, Configuración › Roles, la semilla N3 (por espejo, ver spec) y los tests.
 */
import type { AppNotificationSeverity } from '@/databases/postgresql/entities/automatizaciones-ia/app-notification.entity';

export const NOTIFICATION_MODULES = {
	facturacion: 'Facturación',
	contratos: 'Contratos',
	cotizaciones: 'Cotizaciones',
	ingresos: 'Ingresos',
	integraciones: 'Integraciones',
	sistema: 'Sistema',
} as const;
export type NotificationModule = keyof typeof NOTIFICATION_MODULES;
export const NOTIFICATION_MODULE_KEYS = Object.keys(NOTIFICATION_MODULES) as NotificationModule[];

export const SEVERITY_LABELS: Record<AppNotificationSeverity, string> = { error: 'Bloquea', warning: 'Atención', info: 'Informativo' };
export const SEVERITY_RANK: Record<AppNotificationSeverity, number> = { info: 0, warning: 1, error: 2 };

/** Botón de cada acción (`action_type`). */
export const NOTIFICATION_ACTION_LABELS: Record<string, string> = {
	open_contract: 'Ver contrato',
	review_renewal_proposal: 'Revisar propuesta',
	review_scheduled_change: 'Revisar ajuste',
	retry_salesforce_opportunity: 'Reintentar importación',
	review_salesforce_sync_log: 'Revisar sincronización',
	replace_quantity_record: 'Reemplazar cantidades',
	open_help: 'Ver novedad',
	open_client: 'Ver cliente',
	open_client_activity: 'Ver comentario',
	open_billing_queue: 'Ver facturas por emitir',
	open_invoice: 'Ver factura',
	review_fx_rates: 'Revisar tipos de cambio',
	/** Acción secundaria del cierre de mes (`action_payload.secondary`). */
	move_to_next_month: 'Mover al mes siguiente',
	/** Integraciones v2 (D11): `{ tipo, tab }` → `/conexiones/<tipo>?tab=<tab>`. */
	open_integration: 'Ver integración',
};

const INTEGRATION_TABS = ['estado', 'mapeos', 'configuracion', 'historial'];
const INTEGRATION_TIPOS = ['erp', 'crm', 'stripe', 'datos'];

/** Destino en el lab de las acciones que llevan a Integraciones (D11). El resto lo arma el front (`null`). */
export function actionHref(actionType: string | null | undefined, payload?: Record<string, unknown> | null): string | null {
	if (actionType === 'review_salesforce_sync_log') return '/conexiones/crm?tab=historial';
	if (actionType === 'open_integration') {
		const tipo = String(payload?.tipo ?? '');
		const tab = String(payload?.tab ?? 'estado');

		return INTEGRATION_TIPOS.includes(tipo) ? `/conexiones/${tipo}?tab=${INTEGRATION_TABS.includes(tab) ? tab : 'estado'}` : null;
	}

	return null;
}

/** Roles por defecto (`roles.is_default`, por nombre) y super admins (`role_id NULL`). */
export const DEFAULT_ROLE = {
	admin: 'Administrador',
	finance: 'Finanzas',
	billing: 'Facturación y Cobranza',
	sales: 'Ventas',
	operations: 'Operaciones',
	tech: 'Admin Técnico',
} as const;

export interface NotificationTexts {
	what_happened: string;
	what_to_do: string;
	what_we_do?: string;
}

export interface NotificationCatalogEntry {
	type: string;
	label: string;
	module: NotificationModule;
	icon: string;
	severity: AppNotificationSeverity;
	/** Se configura por rol en Configuración › Roles (los personales y las novedades no). */
	subscribable: boolean;
	/** Está en el catálogo, la semilla y las preferencias, pero todavía sin productor ni oferta en Roles (hoy ninguno: fase 2 los activó). */
	reserved: boolean;
	/** Correo interno de Sapira (solo super admins): no se ofrece en Configuración › Roles ni en las preferencias de quien no es super admin. */
	internal: boolean;
	/** Nombres de los roles por defecto suscritos. */
	default_roles: string[];
	/** Suscripción `role_id NULL`: super admins (Domi y Leon) con membresía activa en el holding. */
	default_super_admins: boolean;
	action_type: string | null;
	/** Dónde se resuelve en Integraciones (D11): "Ver en Integraciones" del detalle. */
	integration_href?: string | null;
	texts: NotificationTexts;
}

const SYNC_FAILURE_ROLES = [DEFAULT_ROLE.admin, DEFAULT_ROLE.tech];
const DATA_WAREHOUSE_ROLES = [DEFAULT_ROLE.admin, DEFAULT_ROLE.finance, DEFAULT_ROLE.billing];
const CONTRACT_ROLES = [DEFAULT_ROLE.admin, DEFAULT_ROLE.finance];

const entry = (value: Omit<NotificationCatalogEntry, 'reserved' | 'internal' | 'default_super_admins'> & Partial<NotificationCatalogEntry>) =>
	({ reserved: false, internal: false, default_super_admins: false, ...value }) as NotificationCatalogEntry;

export const NOTIFICATION_CATALOG: readonly NotificationCatalogEntry[] = [
	entry({
		type: 'invoice_odoo_failure',
		label: 'No se pudo enviar una factura al ERP',
		module: 'facturacion',
		icon: 'receipt-text',
		severity: 'error',
		subscribable: true,
		default_roles: DATA_WAREHOUSE_ROLES,
		action_type: 'open_contract',
		integration_href: '/conexiones/erp?tab=mapeos',
		texts: {
			what_happened: 'La factura no llegó al ERP: el ERP la rechazó o no respondió.',
			what_to_do:
				'Corrige el dato que indica el mensaje en el contrato o en la factura y vuelve a enviarla. Si falta relacionar un producto, hazlo en Integraciones › ERP › Mapeos.',
			what_we_do: 'Reintentamos en la próxima corrida automática y cerramos este aviso cuando la factura se envía bien.',
		},
	}),
	entry({
		type: 'salesforce_staging_blocked',
		label: 'Cotización del CRM detenida',
		module: 'cotizaciones',
		icon: 'file-warning',
		severity: 'error',
		subscribable: true,
		default_roles: [DEFAULT_ROLE.admin, DEFAULT_ROLE.sales, DEFAULT_ROLE.operations],
		action_type: 'retry_salesforce_opportunity',
		integration_href: '/conexiones/crm?tab=mapeos',
		texts: {
			what_happened: 'Una oportunidad ganada en el CRM no se pudo convertir en cotización.',
			what_to_do: 'Revisa el motivo (producto sin relacionar, cuenta o datos faltantes), corrígelo y reintenta la importación.',
			what_we_do: 'Cerramos el aviso cuando la cotización se crea.',
		},
	}),
	entry({
		type: 'salesforce_sync_failure',
		label: 'Falló la sincronización con el CRM',
		module: 'integraciones',
		icon: 'refresh-cw-off',
		severity: 'error',
		subscribable: true,
		default_roles: SYNC_FAILURE_ROLES,
		default_super_admins: true,
		action_type: 'review_salesforce_sync_log',
		integration_href: '/conexiones/crm?tab=historial',
		texts: {
			what_happened: 'La sincronización automática con el CRM no terminó: las oportunidades nuevas no llegaron a Sapira.',
			what_to_do: 'Revisa la conexión y el historial en Integraciones › CRM. Si sigue fallando, avísanos.',
			what_we_do: 'Lo volvemos a intentar en la próxima corrida y cerramos el aviso cuando termine bien.',
		},
	}),
	entry({
		type: 'contract_renewal_proposed',
		label: 'Renovación por confirmar',
		module: 'contratos',
		icon: 'calendar-clock',
		severity: 'info',
		subscribable: true,
		default_roles: CONTRACT_ROLES,
		action_type: 'review_renewal_proposal',
		texts: {
			what_happened: 'Un contrato está por vencer y preparamos la renovación con sus condiciones.',
			what_to_do: 'Ábrela en el Resumen del contrato y confírmala u omítela. No se aplica sola.',
		},
	}),
	entry({
		type: 'contract_renewal_reminder',
		label: 'Vencimiento sin decisión',
		module: 'contratos',
		icon: 'calendar-x',
		severity: 'warning',
		subscribable: true,
		default_roles: CONTRACT_ROLES,
		action_type: 'open_contract',
		texts: {
			what_happened: 'Un producto del contrato vence o ya venció y nadie decidió qué hacer.',
			what_to_do: 'Renuévalo o registra la baja desde el contrato.',
			what_we_do: 'Mientras no se decida, el ingreso sigue reconociéndose como pendiente de renovar.',
		},
	}),
	entry({
		type: 'contract_scheduled_change_due',
		label: 'Ajuste pactado por aplicar',
		module: 'contratos',
		icon: 'trending-up',
		severity: 'info',
		subscribable: true,
		default_roles: CONTRACT_ROLES,
		action_type: 'review_scheduled_change',
		texts: {
			what_happened: 'Llegó la fecha de un ajuste de precio pactado en el contrato.',
			what_to_do: 'Revísalo en el contrato y aplícalo, omítelo esta vez o cancélalo. No se aplica solo.',
		},
	}),
	entry({
		type: 'bigquery_quantities_diff',
		label: 'Consumo distinto en el almacén de datos',
		module: 'facturacion',
		icon: 'database',
		severity: 'warning',
		subscribable: true,
		default_roles: DATA_WAREHOUSE_ROLES,
		action_type: 'replace_quantity_record',
		integration_href: '/conexiones/datos?tab=estado',
		texts: {
			what_happened: 'El almacén de datos cambió un consumo que ya estaba en Sapira. No lo sobrescribimos.',
			what_to_do: 'Compara los valores y reemplaza si el dato nuevo es el correcto.',
		},
	}),
	entry({
		type: 'bigquery_quantities_unmapped',
		label: 'Consumos sin producto asociado',
		module: 'facturacion',
		icon: 'database',
		severity: 'warning',
		subscribable: true,
		default_roles: DATA_WAREHOUSE_ROLES,
		action_type: null,
		integration_href: '/conexiones/datos?tab=estado',
		texts: {
			what_happened: 'Llegaron consumos del almacén de datos que no pudimos asociar a un producto de un contrato.',
			what_to_do: 'Revisa que el producto del contrato tenga el número de ítem de la cotización y vuelve a procesar.',
		},
	}),
	entry({
		type: 'bigquery_quantities_blocked',
		label: 'Consumos que no entraron a la factura',
		module: 'facturacion',
		icon: 'database',
		severity: 'warning',
		subscribable: true,
		default_roles: DATA_WAREHOUSE_ROLES,
		action_type: null,
		integration_href: '/conexiones/datos?tab=estado',
		texts: {
			what_happened: 'Llegaron consumos de un período cuya factura ya no está por emitir.',
			what_to_do: 'Anula la factura del período para que vuelva a estar por emitir y vuelve a procesar.',
		},
	}),
	entry({
		type: 'bigquery_quantities_currency_mismatch',
		label: 'Consumos en otra moneda',
		module: 'facturacion',
		icon: 'database',
		severity: 'warning',
		subscribable: true,
		default_roles: DATA_WAREHOUSE_ROLES,
		action_type: null,
		integration_href: '/conexiones/datos?tab=estado',
		texts: {
			what_happened: 'Llegaron consumos en una moneda distinta a la del contrato. No los integramos para no facturar montos errados.',
			what_to_do: 'Revisa la moneda en el almacén de datos o en el contrato y vuelve a procesar.',
		},
	}),
	entry({
		type: 'fx_sync_failure',
		label: 'Falló la sincronización de tipos de cambio',
		module: 'integraciones',
		icon: 'circle-dollar-sign',
		severity: 'error',
		subscribable: true,

		default_roles: SYNC_FAILURE_ROLES,
		default_super_admins: true,
		action_type: 'review_fx_rates',
		texts: {
			what_happened: 'No pudimos traer los tipos de cambio del día.',
			what_to_do: 'Si emites facturas en otra moneda hoy, revisa la tasa antes de emitir.',
			what_we_do: 'Lo reintentamos automáticamente y te avisamos si sigue fallando.',
		},
	}),
	entry({
		type: 'invoice_fx_fallback',
		label: 'Factura emitida con tasa de respaldo',
		module: 'facturacion',
		icon: 'circle-dollar-sign',
		severity: 'warning',
		subscribable: true,
		internal: true,
		default_roles: [],
		default_super_admins: true,
		action_type: 'open_invoice',
		texts: {
			what_happened: 'Una factura se emitió con la última tasa disponible porque faltaba la del día.',
			what_to_do: 'Revisa la factura y, si la diferencia importa, ajústala.',
		},
	}),
	entry({
		type: 'invoice_fx_missing',
		label: 'Factura no emitida por falta de tasa',
		module: 'facturacion',
		icon: 'circle-dollar-sign',
		severity: 'error',
		subscribable: true,
		internal: true,
		default_roles: [],
		default_super_admins: true,
		action_type: 'open_invoice',
		texts: {
			what_happened: 'Una factura no se emitió porque no había tipo de cambio.',
			what_to_do: 'Registra la tasa y vuelve a emitirla.',
		},
	}),
	entry({
		type: 'scheduler_error_summary',
		label: 'Resumen de errores de emisión',
		module: 'facturacion',
		icon: 'list-x',
		severity: 'error',
		subscribable: true,
		internal: true,
		default_roles: [],
		default_super_admins: true,
		action_type: 'open_billing_queue',
		texts: {
			what_happened: 'La emisión automática del día terminó con errores.',
			what_to_do: 'Revisa las facturas con error en la cola Por emitir.',
		},
	}),
	entry({
		type: 'month_close_pending',
		label: 'Facturas del mes sin emitir',
		module: 'facturacion',
		icon: 'calendar-check',
		severity: 'warning',
		subscribable: true,
		default_roles: DATA_WAREHOUSE_ROLES,
		action_type: 'open_billing_queue',
		texts: {
			what_happened: 'El mes está por cerrar (o ya cerró) y quedan facturas Por Emitir de ese mes.',
			what_to_do: 'Emítelas o muévelas al mes siguiente para que el cierre quede ordenado.',
			what_we_do:
				'Te avisamos el último día hábil del mes y los 3 primeros días hábiles del siguiente; el aviso se cierra solo cuando no quedan.',
		},
	}),
	entry({
		type: 'system_update',
		label: 'Novedad del sistema',
		module: 'sistema',
		icon: 'sparkles',
		severity: 'info',
		subscribable: false,
		default_roles: [],
		action_type: 'open_help',
		texts: {
			what_happened: 'Hay una novedad en Sapira.',
			what_to_do: 'Ábrela en el Centro de ayuda para ver qué cambió.',
		},
	}),
	entry({
		type: 'user_mention',
		label: 'Te mencionaron',
		module: 'sistema',
		icon: 'at-sign',
		severity: 'info',
		subscribable: false,
		default_roles: [],
		action_type: 'open_client_activity',
		texts: {
			what_happened: 'Alguien te mencionó en un comentario.',
			what_to_do: 'Abre el comentario en la Actividad del cliente para responder.',
		},
	}),
];

const BY_TYPE = new Map(NOTIFICATION_CATALOG.map((item) => [item.type, item]));

export const notificationCatalogEntry = (type: string): NotificationCatalogEntry | undefined => BY_TYPE.get(type);
export const isCatalogType = (type: string) => BY_TYPE.has(type);

/** Tipos suscribibles por rol (incluye los reservados: la semilla ya los deja listos). */
export const SUBSCRIBABLE_NOTIFICATION_TYPES = NOTIFICATION_CATALOG.filter((item) => item.subscribable).map((item) => item.type);
/** Los que Configuración › Roles ofrece hoy (suscribibles con productor, sin los correos internos de Sapira). */
export const OFFERED_ROLE_NOTIFICATION_TYPES = NOTIFICATION_CATALOG.filter((item) => item.subscribable && !item.reserved && !item.internal).map(
	(item) => item.type
);
/** Configurables en las preferencias del usuario (todos menos las novedades, que llegan a todos; los internos solo para super admins). */
export const PREFERENCE_NOTIFICATION_TYPES = NOTIFICATION_CATALOG.filter((item) => item.type !== 'system_update').map((item) => item.type);
/** Fila reservada de `user_notification_preferences` para el resumen semanal (usa `email`). */
export const WEEKLY_DIGEST_PREFERENCE = 'weekly_digest';
/** Fila reservada de `user_notification_preferences` para "Mis compañías" (columna `company_ids`; vacío = todas). */
export const MY_COMPANIES_PREFERENCE = 'my_companies';

/**
 * Correo inmediato por defecto (sin fila de preferencia, contrato §8.2): sí para los tipos de gravedad `error` si el usuario es
 * Administrador, y para los tipos que van a super admins por defecto si el usuario es super admin (correos internos de siempre). No en el resto.
 */
export function defaultEmailFor(type: string, user: { role_name?: string | null; is_super_admin?: boolean | null }): boolean {
	const item = BY_TYPE.get(type);

	if (!item || item.type === 'system_update') return false;
	if (user.is_super_admin && item.default_super_admins) return true;

	return item.severity === 'error' && user.role_name === DEFAULT_ROLE.admin;
}

/** Resumen semanal por defecto (sin fila): sí para Administrador y Finanzas. */
export const defaultWeeklyDigestFor = (roleName?: string | null): boolean => roleName === DEFAULT_ROLE.admin || roleName === DEFAULT_ROLE.finance;

export const typesOfModules = (modules: string[]) => NOTIFICATION_CATALOG.filter((item) => modules.includes(item.module)).map((item) => item.type);

/** Módulo de un tipo (los fuera de catálogo, como la heredada `contract_notifications`, van a Sistema). */
export const moduleOfType = (type: string): NotificationModule => BY_TYPE.get(type)?.module ?? 'sistema';

/** Suscripciones por defecto de un tipo: nombres de rol + `null` para super admins. */
export function defaultSubscriptions(): Array<{ type: string; role_name: string | null }> {
	return NOTIFICATION_CATALOG.filter((item) => item.subscribable).flatMap((item) => [
		...item.default_roles.map((role) => ({ type: item.type, role_name: role })),
		...(item.default_super_admins ? [{ type: item.type, role_name: null }] : []),
	]);
}

/** Textos resueltos del detalle: los del productor mandan; la plantilla del catálogo completa. */
export function resolveTexts(notification: { type: string; message?: string | null; recommendation?: string | null }) {
	const texts = BY_TYPE.get(notification.type)?.texts;

	return {
		what_happened: notification.message?.trim() || texts?.what_happened || '',
		what_to_do: notification.recommendation?.trim() || texts?.what_to_do || '',
		what_we_do: texts?.what_we_do ?? null,
	};
}
