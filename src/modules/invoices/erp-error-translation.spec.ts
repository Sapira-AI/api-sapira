import { cleanErpMessage, electronicRejectionReason, erpErrorSentence, exhaustedFolios, missingFxPairs, translateErpError } from './erp-error-translation';

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
		// Corrida del 28-10 (SimpliRoute): 29 facturas de Chile sin folios CAF y 1 de México con el timbrado rechazado por el PAC.
		[
			'Error emitiendo factura en Odoo: XML-RPC Fault: No hay CAFs disponible para el folio 28401 en la secuencia de Electronic Invoice. Por favor subo un archivo CAF o solicite uno nuevo en el sitio www.sii.cl (Code: 2)',
			'odoo_post_exception',
			'folios_exhausted',
			'none',
		],
		[
			'Error emitiendo factura México en Odoo: XML-RPC Fault: Ocurrió un error al enviar el CFDI al PAC: - Código: CFDI40147 - El campo DomicilioFiscalReceptor del receptor, debe encontrarse en la lista de RFC inscritos no cancelados en el SAT.',
			'emit_electronic_exception',
			'electronic_rejected',
			'client_entity',
		],
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
		expect(translateErpError(null)).toMatchObject({ category: 'unknown', raw: null, message: 'No se pudo enviar la factura al ERP' });
		expect(cleanErpMessage('Traceback (most recent call last): boom')).toBe('');
	});

	it('desconocido con texto: muestra la primera frase útil del ERP en vez de la frase genérica (Domi 28-10)', () => {
		const translation = translateErpError('Error emitiendo factura en Odoo: XML-RPC Fault: El diario de la compañía no admite este documento (Code: 2)', 'odoo_post_exception');

		// "diario" cae en journal_missing; uno realmente nuevo va a unknown con su texto.
		expect(translation.category).toBe('journal_missing');
		const unknown = translateErpError('Error emitiendo factura en Odoo: XML-RPC Fault: La secuencia no está configurada para este tipo (Code: 2)', 'odoo_post_exception');

		expect(unknown).toMatchObject({ category: 'unknown', action: 'none' });
		// Sin "XML-RPC Fault" ni el "(Code: 2)" de Odoo.
		expect(unknown.message).toBe('El ERP respondió: La secuencia no está configurada para este tipo');
		expect(erpErrorSentence(unknown)).toMatch(/^El ERP respondió: .* Revisa el detalle técnico o vuelve a intentarlo en unos minutos\.$/);
	});
});

describe('corrida del 28-10: folios CAF agotados (Chile) y timbrado rechazado (México)', () => {
	const CAF =
		'Error emitiendo factura en Odoo: XML-RPC Fault: No hay CAFs disponible para el folio 28401 en la secuencia de Electronic Invoice. Por favor subo un archivo CAF o solicite uno nuevo en el sitio www.sii.cl (Code: 2)';
	const PAC =
		'Error emitiendo factura México en Odoo: XML-RPC Fault: Ocurrió un error al enviar el CFDI al PAC: - Código: CFDI40147 - El campo DomicilioFiscalReceptor del receptor, debe encontrarse en la lista de RFC inscritos no cancelados en el SAT.';

	it('CAF: nombra el tipo de documento y el folio que faltó; el paso siguiente es pedir el CAF y confirmar los borradores en Odoo', () => {
		const translation = translateErpError(CAF, 'odoo_post_exception');

		expect(translation).toMatchObject({ category: 'folios_exhausted', action: 'none', raw: CAF });
		expect(translation.message).toBe('Se acabaron los folios autorizados por el SII para facturas electrónicas (siguiente folio 28401)');
		expect(translation.next_step).toBe('Solicita un CAF nuevo en sii.cl y cárgalo en Odoo; después confirma allí los borradores que quedaron sin folio');
		expect(exhaustedFolios('No hay CAFs disponible para el folio 512 en la secuencia de Electronic Credit Note.')).toEqual({
			document: 'notas de crédito electrónicas',
			next_folio: '512',
		});
		expect(exhaustedFolios('No hay CAF disponible')).toEqual({ document: 'los documentos electrónicos', next_folio: null });
		expect(exhaustedFolios('Falta el diario')).toBeNull();
	});

	it('PAC: código conocido en palabras (y el código entre paréntesis); código desconocido con el motivo limpio del PAC; acción = razón social', () => {
		const translation = translateErpError(PAC, 'emit_electronic_exception');

		expect(translation).toMatchObject({ category: 'electronic_rejected', action: 'client_entity', raw: PAC });
		expect(translation.message).toBe(
			'El SAT rechazó el timbrado: el domicilio fiscal (código postal) del cliente no coincide con el registrado en el SAT para su RFC (CFDI40147)'
		);
		expect(translation.next_step).toBe('Corrige en Odoo los datos fiscales del cliente según su Constancia de Situación Fiscal y vuelve a timbrar desde Odoo');
		expect(
			translateErpError('Ocurrió un error al enviar el CFDI al PAC: - Código: CFDI33132 - La longitud del campo NoCertificado debe ser igual a 20 posiciones.', 'electronic_rejection').message
		).toBe('El SAT rechazó el timbrado: la longitud del campo NoCertificado debe ser igual a 20 posiciones (CFDI33132)');
		expect(electronicRejectionReason('Error creando factura en borrador: falta el diario')).toBeNull();
		// Un error de Odoo que menciona "receptor" sin PAC/CFDI no entra acá.
		expect(translateErpError('El receptor no tiene correo', 'odoo_rejection').category).not.toBe('electronic_rejected');
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
