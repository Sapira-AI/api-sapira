import { cleanErpMessage, erpErrorSentence, missingFxPairs, translateErpError } from './erp-error-translation';

describe('translateErpError (errores del envío al ERP en palabras de la usuaria)', () => {
	it.each([
		['Cliente no tiene odoo_partner_id', 'validation', 'partner_not_linked', 'client_entity'],
		[
			'Error enviando factura al cliente desde Odoo: La factura 12 no tiene cliente configurado en Odoo',
			undefined,
			'partner_not_linked',
			'client_entity',
		],
		['Productos sin mapeo a Odoo: Soporte Premium', 'product_without_erp_mapping', 'product_without_mapping', 'map_product'],
		['Taxes incompatibles con la compañía 3', 'tax_validation', 'tax_not_found', 'integrations'],
		[
			'Error creando factura en borrador en Odoo: ValidationError: The currency USD is not active',
			'odoo_rejection',
			'currency_inactive',
			'integrations',
		],
		[
			'Error creando factura en borrador en Odoo: No journal could be found in company Sapira SpA for any of those types: sale',
			'odoo_rejection',
			'journal_missing',
			'integrations',
		],
		[
			'UserError: You cannot add/modify entries prior to and inclusive of the lock date 2026-08-31',
			'odoo_rejection',
			'period_closed',
			'reschedule',
		],
		['ValidationError: The invoice number must be unique per company (duplicate key)', 'odoo_rejection', 'duplicate_number', 'open_invoice'],
		['No hay tipo de cambio disponible para USD/CLP en fecha 2026-07-10', 'exchange_rate', 'fx_rate_missing', 'fx'],
		['connect ETIMEDOUT 10.0.0.1:443', 'unexpected_exception', 'connection', 'retry'],
		['Falló la autenticación con Odoo', 'unexpected_exception', 'connection', 'retry'],
		[
			'Error creando factura en borrador en Odoo: ValidationError: El campo "Plazo de pago" es obligatorio',
			'odoo_rejection',
			'validation',
			'open_invoice',
		],
		['Algo raro pasó', undefined, 'unknown', 'none'],
	])('%s → %s', (raw, errorType, category, action) => {
		const translation = translateErpError(raw, errorType);

		expect(translation.category).toBe(category);
		expect(translation.action).toBe(action);
		expect(translation.raw).toBe(raw);
		expect(translation.message).not.toMatch(/odoo_partner_id|ValidationError|_id\b/);
		expect(translation.next_step.length).toBeGreaterThan(10);
	});

	it('nombra los productos sin mapeo y arma la frase completa', () => {
		const translation = translateErpError('Productos sin mapeo a Odoo: Plan Pro, Soporte');

		expect(translation.message).toBe('Hay productos sin mapeo en Odoo: Plan Pro, Soporte');
		expect(erpErrorSentence(translation)).toBe(
			'Hay productos sin mapeo en Odoo: Plan Pro, Soporte. Relaciona el producto en Integraciones › ERP › Mapeos y vuelve a enviarla.'
		);
	});

	it('validación genérica: limpia prefijos técnicos y nombres de excepción', () => {
		const translation = translateErpError(
			'Error creando factura en borrador en Odoo: odoo.exceptions.ValidationError: El campo "Plazo de pago" es obligatorio',
			'odoo_rejection'
		);

		expect(translation.message).toBe('Odoo rechazó la factura: El campo "Plazo de pago" es obligatorio');
	});

	it('sin texto: desconocido con raw null', () => {
		expect(translateErpError(null)).toMatchObject({ category: 'unknown', raw: null });
		expect(cleanErpMessage('Traceback (most recent call last): boom')).toBe('');
	});
});

describe('fx_rate_missing con el par que falta (Domi 23-10)', () => {
	it('conserva los pares que nombra el scheduler, unidos con "y"; sin pares, la frase genérica', () => {
		expect(
			translateErpError(
				'fx_rate_missing: la factura INV-161 usa tipo de cambio fijo y no tiene tasa para USD → CLP, CLF → CLP: confírmala desde el contrato antes de enviarla.',
				'exchange_rate'
			)
		).toMatchObject({ category: 'fx_rate_missing', message: 'Falta el tipo de cambio para USD → CLP y CLF → CLP', action: 'fx' });
		expect(translateErpError('No hay tipo de cambio disponible para USD/CLP en fecha 2026-07-10', 'exchange_rate').message).toBe(
			'Falta el tipo de cambio para USD → CLP'
		);
		expect(translateErpError('Montos no calculados para la factura', 'amount_calculation').message).toBe(
			'Falta el tipo de cambio para valorizar la factura en su moneda'
		);
		expect(missingFxPairs('… no tiene tasa para USD → CLP, CLF → CLP, MXN → CLP: …')).toBe('USD → CLP, CLF → CLP y MXN → CLP');
		expect(missingFxPairs('sin pares')).toBeNull();
		// Texto del servicio de tasas (rama simple sin tasa en o antes de la fecha).
		expect(translateErpError('No se encontró tipo de cambio para USD/CLP en o antes de 2026-10-23', 'exchange_rate').message).toBe(
			'Falta el tipo de cambio para USD → CLP'
		);
		// Sin falsos positivos: solo códigos de moneda en mayúsculas y completos (revisión 23-10).
		expect(missingFxPairs('no tiene tasa para esa línea')).toBeNull();
		expect(missingFxPairs('No hay tipo de cambio disponible para esta fecha')).toBeNull();
		expect(missingFxPairs('tasa para USDX')).toBeNull();
		expect(missingFxPairs('tasa para USD → CLPX')).toBeNull();
		expect(translateErpError('No hay tipo de cambio disponible para esta fecha', 'exchange_rate').message).toBe(
			'Falta el tipo de cambio para valorizar la factura en su moneda'
		);
	});
});
