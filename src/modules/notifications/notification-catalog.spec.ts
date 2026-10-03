import { readFileSync } from 'fs';
import { join } from 'path';

import {
	defaultEmailFor,
	defaultSubscriptions,
	defaultWeeklyDigestFor,
	NOTIFICATION_ACTION_LABELS,
	NOTIFICATION_CATALOG,
	NOTIFICATION_MODULES,
	OFFERED_ROLE_NOTIFICATION_TYPES,
	PREFERENCE_NOTIFICATION_TYPES,
	resolveTexts,
	typesOfModules,
} from './notification-catalog';

const DB = join(__dirname, '../../databases/postgresql');
const read = (path: string) => readFileSync(join(DB, path), 'utf8');

describe('catálogo de notificaciones', () => {
	it('tiene los 10 tipos de la fase 1, los 4 correos internos, el cierre de mes, las novedades y las menciones (ninguno reservado)', () => {
		expect(NOTIFICATION_CATALOG.map((item) => item.type)).toEqual([
			'invoice_odoo_failure',
			'salesforce_staging_blocked',
			'salesforce_sync_failure',
			'contract_renewal_proposed',
			'contract_renewal_reminder',
			'contract_scheduled_change_due',
			'bigquery_quantities_diff',
			'bigquery_quantities_unmapped',
			'bigquery_quantities_blocked',
			'bigquery_quantities_currency_mismatch',
			'fx_sync_failure',
			'invoice_fx_fallback',
			'invoice_fx_missing',
			'scheduler_error_summary',
			'month_close_pending',
			'system_update',
			'user_mention',
		]);
		expect(NOTIFICATION_CATALOG.filter((item) => item.reserved)).toEqual([]);
		expect(NOTIFICATION_CATALOG.filter((item) => item.internal).map((item) => item.type)).toEqual([
			'invoice_fx_fallback',
			'invoice_fx_missing',
			'scheduler_error_summary',
		]);
	});

	it('correo y resumen semanal por defecto (contrato §8.2)', () => {
		const admin = { role_name: 'Administrador', is_super_admin: false };
		const finance = { role_name: 'Finanzas', is_super_admin: false };
		const superAdmin = { role_name: null, is_super_admin: true };

		expect(defaultEmailFor('invoice_odoo_failure', admin)).toBe(true);
		expect(defaultEmailFor('invoice_odoo_failure', finance)).toBe(false);
		expect(defaultEmailFor('contract_renewal_reminder', admin)).toBe(false);
		expect(defaultEmailFor('invoice_fx_fallback', superAdmin)).toBe(true);
		expect(defaultEmailFor('fx_sync_failure', superAdmin)).toBe(true);
		expect(defaultEmailFor('month_close_pending', superAdmin)).toBe(false);
		expect(defaultEmailFor('system_update', admin)).toBe(false);
		expect(defaultWeeklyDigestFor('Administrador')).toBe(true);
		expect(defaultWeeklyDigestFor('Finanzas')).toBe(true);
		expect(defaultWeeklyDigestFor('Ventas')).toBe(false);
		expect(defaultWeeklyDigestFor(null)).toBe(false);
	});

	it('cada tipo tiene módulo conocido, ícono, textos y su acción con botón; el copy no nombra marcas', () => {
		for (const item of NOTIFICATION_CATALOG) {
			expect(NOTIFICATION_MODULES[item.module]).toBeDefined();
			expect(item.icon).toMatch(/^[a-z-]+$/);
			expect(item.texts.what_happened).not.toBe('');
			expect(item.texts.what_to_do).not.toBe('');
			if (item.action_type) expect(NOTIFICATION_ACTION_LABELS[item.action_type]).toBeDefined();
			const copy = [item.label, item.texts.what_happened, item.texts.what_to_do, item.texts.what_we_do ?? ''].join(' ');

			expect(copy).not.toMatch(/Salesforce|Odoo|BigQuery|DWH|HubSpot/);
		}
	});

	it('destinatarios por defecto (decisión de Domi 03-10)', () => {
		const rolesOf = (type: string) =>
			defaultSubscriptions()
				.filter((item) => item.type === type)
				.map((item) => item.role_name);

		expect(rolesOf('invoice_odoo_failure')).toEqual(['Administrador', 'Finanzas', 'Facturación y Cobranza']);
		expect(rolesOf('salesforce_staging_blocked')).toEqual(['Administrador', 'Ventas', 'Operaciones']);
		expect(rolesOf('salesforce_sync_failure')).toEqual(['Administrador', 'Admin Técnico', null]);
		expect(rolesOf('fx_sync_failure')).toEqual(['Administrador', 'Admin Técnico', null]);
		expect(rolesOf('contract_renewal_reminder')).toEqual(['Administrador', 'Finanzas']);
		expect(rolesOf('bigquery_quantities_diff')).toEqual(['Administrador', 'Finanzas', 'Facturación y Cobranza']);
		expect(rolesOf('scheduler_error_summary')).toEqual([null]);
		expect(rolesOf('system_update')).toEqual([]);
		expect(rolesOf('month_close_pending')).toEqual(['Administrador', 'Finanzas', 'Facturación y Cobranza']);
	});

	it('las semillas N3 + N8 y create_default_roles_for_holding son espejo exacto de defaultSubscriptions()', () => {
		const expected = defaultSubscriptions()
			.map((item) => `${item.type}|${item.role_name ?? 'NULL'}`)
			.sort();
		const seed = read('seed/007-notification-default-subscriptions.sql');
		const seed8 = read('seed/008-notification-month-close-subscriptions.sql');
		const seed8Roles = [...seed8.matchAll(/\('([a-z_]+)', '([^']+)'\)/g)].map(([, type, role]) => `${type}|${role}`);
		const seedRoles = [...seed.matchAll(/\('([a-z_]+)', '([^']+)'\)/g)].map(([, type, role]) => `${type}|${role}`);
		const superBlock = seed.slice(seed.indexOf('super_admin_types(notification_type) AS ('), seed.indexOf('CROSS JOIN'));
		const seedSuper = [...superBlock.matchAll(/\('([a-z_]+)'\)/g)].map(([, type]) => `${type}|NULL`);

		expect([...seedRoles, ...seedSuper, ...seed8Roles].sort()).toEqual(expected);
		expect(seed).toContain('r.is_default = true');
		expect(seed8).toContain('NOT EXISTS');
		expect(seed).toContain('NOT EXISTS');

		const variables: Record<string, string> = {
			v_admin_role_id: 'Administrador',
			v_finanzas_role_id: 'Finanzas',
			v_facturacion_role_id: 'Facturación y Cobranza',
			v_ventas_role_id: 'Ventas',
			v_operaciones_role_id: 'Operaciones',
			v_admin_tecnico_role_id: 'Admin Técnico',
		};
		const fn = read('functions/create_default_roles_for_holding.sql');
		const fnRows = [...fn.matchAll(/\((v_[a-z_]+|NULL::uuid), '([a-z_]+)'\)/g)].map(
			([, variable, type]) => `${type}|${variable === 'NULL::uuid' ? 'NULL' : variables[variable]}`
		);

		expect(fnRows.sort()).toEqual(expected);
		expect(fn).toContain('PENDIENTE DE OK DE DOMI (Notificaciones v2');
	});

	it('Roles ofrece los suscribibles con productor sin los correos internos; las preferencias, todos menos las novedades', () => {
		expect(OFFERED_ROLE_NOTIFICATION_TYPES).toHaveLength(12);
		expect(OFFERED_ROLE_NOTIFICATION_TYPES).toContain('fx_sync_failure');
		expect(OFFERED_ROLE_NOTIFICATION_TYPES).toContain('month_close_pending');
		expect(OFFERED_ROLE_NOTIFICATION_TYPES).not.toContain('invoice_fx_fallback');
		expect(PREFERENCE_NOTIFICATION_TYPES).toContain('user_mention');
		expect(PREFERENCE_NOTIFICATION_TYPES).not.toContain('system_update');
		expect(typesOfModules(['contratos'])).toEqual(['contract_renewal_proposed', 'contract_renewal_reminder', 'contract_scheduled_change_due']);
	});

	it('textos resueltos: manda el productor y la plantilla completa', () => {
		expect(resolveTexts({ type: 'contract_renewal_reminder', message: '', recommendation: null })).toEqual({
			what_happened: 'Un producto del contrato vence o ya venció y nadie decidió qué hacer.',
			what_to_do: 'Renuévalo o registra la baja desde el contrato.',
			what_we_do: 'Mientras no se decida, el ingreso sigue reconociéndose como pendiente de renovar.',
		});
		expect(resolveTexts({ type: 'contract_notifications', message: 'Heredada', recommendation: 'Hacer algo' })).toEqual({
			what_happened: 'Heredada',
			what_to_do: 'Hacer algo',
			what_we_do: null,
		});
	});

	it('migración de la fase 2 (N4–N7): aditiva, RLS activada sin políticas en el registro de correos', () => {
		const n = read('migrations/1790900000000-NotificationsPhase2.ts');

		expect(n).toContain('ALTER TABLE "app_notifications" ADD "company_id" uuid');
		expect(n).toContain('ON DELETE SET NULL');
		expect(n).toContain('ALTER TABLE "user_notification_preferences" ADD "company_ids" uuid array');
		expect(n).toContain('CONSTRAINT "notification_email_log_user_dedup_key" UNIQUE ("user_id", "dedup_key")');
		expect(n).toContain('ALTER TABLE "notification_email_log" ENABLE ROW LEVEL SECURITY');
		expect(n).toContain('"mentioned_user_ids" uuid array NOT NULL DEFAULT \'{}\'');
		expect(n).toContain('"references" jsonb NOT NULL DEFAULT \'[]\'');
		expect(n).not.toContain('CREATE POLICY');
		expect(n).not.toMatch(/DROP (TABLE|COLUMN)(?! IF EXISTS)/);
	});

	it('migraciones N1 y N2: aditivas, RLS activada sin políticas en la tabla nueva', () => {
		const n1 = read('migrations/1790880000000-NotificationRecipientsArchivedAt.ts');
		const n2 = read('migrations/1790890000000-UserNotificationPreferences.ts');

		expect(n1).toContain('ADD "archived_at" TIMESTAMP WITH TIME ZONE');
		expect(n2).toContain(
			'CONSTRAINT "user_notification_preferences_user_holding_type_key" UNIQUE ("user_id", "holding_id", "notification_type")'
		);
		expect(n2).toContain('"in_app" boolean NOT NULL DEFAULT true');
		expect(n2).toContain('"email" boolean NOT NULL DEFAULT false');
		expect(n2).toContain('ENABLE ROW LEVEL SECURITY');
		expect(n2).not.toContain('CREATE POLICY');
	});
});
