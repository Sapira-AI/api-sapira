import { actionHref, NOTIFICATION_CATALOG, notificationCatalogEntry } from './notification-catalog';
import { toView } from './notifications.service';

/** Integraciones v2 (D11): acciones y enlaces que llevan a `/conexiones/<tipo>?tab=…`, y textos sin marcas. */
describe('Notificaciones · enlaces a Integraciones (D11)', () => {
	it('la falla del CRM abre el historial del CRM', () => {
		expect(actionHref('review_salesforce_sync_log', {})).toBe('/conexiones/crm?tab=historial');
	});

	it('open_integration arma la ruta con tipo y pestaña válidos', () => {
		expect(actionHref('open_integration', { tipo: 'erp', tab: 'mapeos' })).toBe('/conexiones/erp?tab=mapeos');
		expect(actionHref('open_integration', { tipo: 'datos', tab: 'otra' })).toBe('/conexiones/datos?tab=estado');
		expect(actionHref('open_integration', { tipo: 'odoo' })).toBeNull();
		expect(actionHref('open_contract', { contract_id: 'c-1' })).toBeNull();
	});

	it('cada tipo de integraciones tiene su integration_href', () => {
		expect(notificationCatalogEntry('invoice_odoo_failure')?.integration_href).toBe('/conexiones/erp?tab=mapeos');
		expect(notificationCatalogEntry('salesforce_staging_blocked')?.integration_href).toBe('/conexiones/crm?tab=mapeos');
		expect(notificationCatalogEntry('salesforce_sync_failure')?.integration_href).toBe('/conexiones/crm?tab=historial');
		for (const type of [
			'bigquery_quantities_diff',
			'bigquery_quantities_unmapped',
			'bigquery_quantities_blocked',
			'bigquery_quantities_currency_mismatch',
		]) {
			expect(notificationCatalogEntry(type)?.integration_href).toBe('/conexiones/datos?tab=estado');
		}
	});

	it('los textos del catálogo no nombran el sistema conectado', () => {
		for (const item of NOTIFICATION_CATALOG) {
			expect(`${item.label} ${item.texts.what_happened} ${item.texts.what_to_do} ${item.texts.what_we_do ?? ''}`).not.toMatch(
				/Odoo|Salesforce|Stripe|BigQuery/
			);
		}
		expect(notificationCatalogEntry('invoice_odoo_failure')?.texts.what_to_do).toContain('Integraciones › ERP › Mapeos');
	});

	it('la vista agrega action.href e integration_href (superconjunto)', () => {
		const view = toView({
			id: 'n-1',
			type: 'salesforce_sync_failure',
			severity: 'error',
			action_type: 'review_salesforce_sync_log',
			action_payload: { job_id: 'j-1' },
			is_read: false,
		} as never);

		expect(view.action).toEqual({
			type: 'review_salesforce_sync_log',
			label: 'Revisar sincronización',
			payload: { job_id: 'j-1' },
			href: '/conexiones/crm?tab=historial',
		});
		expect(view.integration_href).toBe('/conexiones/crm?tab=historial');
	});
});
