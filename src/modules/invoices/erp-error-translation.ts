/**
 * Traducción de errores del envío al ERP (Odoo) a palabras de la usuaria (Contratos v2 · pedido de Domi 02-10, cambio puntual avisado a
 * Leon en `docs/v2-rediseno/cambios-integracion-para-leon.md` §9). Función pura y aditiva: NO cambia la lógica del envío; toma el texto
 * técnico que ya produce el scheduler (`result.error` / `error_message` del log) y, si lo hay, su `errorType`, y devuelve una categoría con
 * mensaje, paso siguiente y la acción de la UI que lo resuelve. El texto técnico queda en `raw` ("detalle técnico" plegable).
 */

export const ERP_ERROR_CATEGORIES = [
	'partner_not_linked',
	'product_without_mapping',
	'tax_not_found',
	'currency_inactive',
	'journal_missing',
	'period_closed',
	'duplicate_number',
	'fx_rate_missing',
	/** Chile: la secuencia del documento electrónico no tiene folios autorizados (CAF) en Odoo; el borrador queda sin publicar. */
	'folios_exhausted',
	/** El timbrador (PAC/SAT en México) rechazó el documento ya publicado en Odoo. */
	'electronic_rejected',
	'connection',
	'validation',
	'unknown',
] as const;
export type ErpErrorCategory = (typeof ERP_ERROR_CATEGORIES)[number];

/** Acción de la UI (mismo vocabulario que `BLOCKER_ACTIONS` de `billing-states.ts`, más `retry`). */
export type ErpErrorAction =
	| 'client_entity'
	| 'map_product'
	| 'integrations'
	| 'company_settings'
	| 'fx'
	| 'reschedule'
	| 'references'
	| 'open_invoice'
	| 'retry'
	| 'none';

export interface ErpErrorTranslation {
	category: ErpErrorCategory;
	/** Qué pasó, en una frase sin códigos. */
	message: string;
	/** Qué hacer. */
	next_step: string;
	action: ErpErrorAction;
	/** Texto técnico original (limpio de espacios), para el "detalle técnico". */
	raw: string | null;
}

const MAX_CLEAN = 240;

/**
 * Pares sin tasa que nombra el texto técnico ("…tasa para USD → CLP, CLF → CLP: …" del scheduler por pares, "…disponible para USD/CLP en
 * fecha …" del scheduler simple, "No se encontró tipo de cambio para USD/CLP en o antes de …" del servicio de tasas), unidos con "y"; null
 * si no los trae. Solo códigos de moneda en mayúsculas y completos: "para esa línea" o "para esta fecha" no cuentan (revisión 23-10).
 */
export function missingFxPairs(raw: string | null | undefined): string | null {
	const code = '[A-Z]{3}';
	const pair = `${code}(?:\\s*(?:→|->|\\/)\\s*${code})?`;
	const match = String(raw ?? '').match(
		new RegExp(`(?:tasa|tipo de cambio(?: disponible)?) para (${pair}(?:,\\s*${pair})*)(?![A-Za-z])(?!\\s*(?:→|->|\\/))`)
	);

	if (!match) return null;
	const pairs = match[1]
		.split(',')
		.map((pair) => pair.trim().replace(/\s*(?:->|\/)\s*/, ' → '))
		.filter(Boolean);

	return pairs.length > 1 ? `${pairs.slice(0, -1).join(', ')} y ${pairs[pairs.length - 1]}` : (pairs[0] ?? null);
}

/** Quita prefijos técnicos, trazas y nombres de excepciones de un mensaje de Odoo y deja la primera frase útil. */
export function cleanErpMessage(raw: string | null | undefined): string {
	if (!raw) return '';
	let text = String(raw)
		.replace(/Traceback[\s\S]*$/i, '')
		.replace(
			/^(?:\s*(?:Error (?:creando factura en borrador|emitiendo factura(?: [^:]+)?|enviando factura al cliente desde Odoo)(?: en Odoo)?|Error)\s*:\s*)+/i,
			''
		)
		.replace(/\b(?:odoo\.exceptions\.)?(?:ValidationError|UserError|AccessError|MissingError|RedirectWarning)\b\s*:?\s*/g, '')
		.replace(/<Fault[^>]*>|XML-RPC\s*Fault\s*:?|Fault\s*\d*\s*:?/gi, '')
		.replace(/\s*\(Code:\s*\d+\)\s*$/i, '')
		.replace(/[\r\n]+/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.replace(/^["'\s(]+|["'\s)]+$/g, '')
		.trim();

	if (text.length > MAX_CLEAN) text = `${text.slice(0, MAX_CLEAN - 1).trimEnd()}…`;

	return text;
}

const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Nombre en Odoo de la secuencia de documentos electrónicos (Chile) → cómo lo decimos. */
const SEQUENCE_LABELS: Array<[RegExp, string]> = [
	[/electronic exempt invoice|factura exenta/i, 'facturas exentas electrónicas'],
	[/electronic export invoice|factura de exportaci/i, 'facturas de exportación electrónicas'],
	[/electronic credit note|nota de cr/i, 'notas de crédito electrónicas'],
	[/electronic debit note|nota de d/i, 'notas de débito electrónicas'],
	[/electronic invoice|factura electr/i, 'facturas electrónicas'],
];

/**
 * Folios agotados (Chile): "No hay CAFs disponible para el folio 28401 en la secuencia de Electronic Invoice. Por favor subo un archivo CAF
 * o solicite uno nuevo en el sitio www.sii.cl". Devuelve el tipo de documento y el folio que faltó, si el texto los trae.
 */
export function exhaustedFolios(raw: string | null | undefined): { document: string; next_folio: string | null } | null {
	const text = String(raw ?? '');

	if (!/\bcafs?\b/i.test(text)) return null;
	const folio = text.match(/folio\s+(\d+)/i)?.[1] ?? null;
	const sequence = text.match(/secuencia(?: de)?\s+([^.\n]+?)(?:\.|$| por favor)/i)?.[1]?.trim() ?? null;
	const document = sequence ? (SEQUENCE_LABELS.find(([pattern]) => pattern.test(sequence))?.[1] ?? `la secuencia ${sequence}`) : 'los documentos electrónicos';

	return { document, next_folio: folio };
}

/** Códigos del SAT que sabemos decir en palabras; el resto va con el motivo limpio del PAC. */
const SAT_CODE_MESSAGES: Record<string, string> = {
	CFDI40147: 'el domicilio fiscal (código postal) del cliente no coincide con el registrado en el SAT para su RFC',
	CFDI40145: 'el régimen fiscal del cliente no corresponde a su RFC',
	CFDI40143: 'el nombre o razón social del cliente no coincide con el registrado en el SAT para su RFC',
	CFDI40142: 'el RFC del cliente no está en la lista de RFC inscritos no cancelados del SAT',
};

/**
 * Timbrado rechazado (México): "Ocurrió un error al enviar el CFDI al PAC: - Código: CFDI40147 - El campo DomicilioFiscalReceptor del
 * receptor, debe encontrarse en la lista de RFC inscritos no cancelados en el SAT." Devuelve el motivo en palabras (código conocido) o el
 * texto limpio del PAC después del código; null si el texto no es un rechazo del timbrado.
 */
export function electronicRejectionReason(raw: string | null | undefined): { code: string | null; reason: string } | null {
	const text = String(raw ?? '');

	if (!/\b(?:cfdi|pac|timbr|sat)\b/i.test(text)) return null;
	const code = text.match(/\b(CFDI\d{5})\b/i)?.[1]?.toUpperCase() ?? null;
	const known = code ? SAT_CODE_MESSAGES[code] : undefined;

	if (known) return { code, reason: known };
	// Lo que sigue al código ("- Código: CFDI40147 - <motivo>") o, sin código, lo que sigue a "al PAC:".
	const after = text.match(/CFDI\d{5}\s*[-–:]?\s*([^\n]+)/i)?.[1] ?? text.match(/al PAC\s*:\s*[-–\s]*([^\n]+)/i)?.[1] ?? null;
	const reason = cleanErpMessage(after ?? text).replace(/^[-–\s]+/, '');

	return { code, reason: reason ? reason.charAt(0).toLowerCase() + reason.slice(1) : 'el documento no cumple una validación del SAT' };
}

const build = (category: ErpErrorCategory, message: string, next_step: string, action: ErpErrorAction, raw: string | null): ErpErrorTranslation => ({
	category,
	message,
	next_step,
	action,
	raw,
});

/**
 * Clasifica un error del envío al ERP. `errorType` es el del log del scheduler (`validation`, `exchange_rate`, `tax_validation`,
 * `product_without_erp_mapping`, `odoo_rejection`, `unexpected_exception`…); el texto manda cuando el tipo es genérico.
 */
export function translateErpError(rawInput: string | null | undefined, errorType?: string | null): ErpErrorTranslation {
	const raw = rawInput ? String(rawInput).replace(/\s+/g, ' ').trim() || null : null;
	const text = normalize(raw ?? '');
	const type = (errorType ?? '').toLowerCase();
	const has = (pattern: RegExp) => pattern.test(text);

	if (type === 'product_without_erp_mapping' || has(/sin mapeo a odoo|product_without_erp_mapping|producto sin mapeo/)) {
		const names = raw?.match(/sin mapeo a Odoo:\s*(.+)$/i)?.[1]?.trim();

		return build(
			'product_without_mapping',
			names ? `Hay productos sin mapeo en Odoo: ${names}` : 'Un producto de la factura no está mapeado a un producto de Odoo',
			'Relaciona el producto en Integraciones › ERP › Mapeos y vuelve a enviarla',
			'map_product',
			raw
		);
	}
	if (type === 'exchange_rate' || type === 'amount_calculation' || has(/tipo de cambio|exchange rate|fx_rate|montos no calculados/)) {
		// El scheduler ya nombra los pares que faltan ("…tasa para USD → CLP, CLF → CLP: …" / "…disponible para USD/CLP en fecha …"):
		// se conservan en el mensaje (Domi 23-10) en vez de la frase genérica.
		const pairs = missingFxPairs(raw ?? text);

		return build(
			'fx_rate_missing',
			pairs ? `Falta el tipo de cambio para ${pairs}` : 'Falta el tipo de cambio para valorizar la factura en su moneda',
			'Confirma la tasa desde Tipo de cambio de la factura y vuelve a enviarla',
			'fx',
			raw
		);
	}
	// Casos reales de la corrida del 28-10 (SimpliRoute): van antes de las ramas laxas (impuesto, diario, validación) para que no las pisen.
	const folios = exhaustedFolios(raw);

	if (folios) {
		return build(
			'folios_exhausted',
			`Se acabaron los folios autorizados por el SII para ${folios.document}${folios.next_folio ? ` (siguiente folio ${folios.next_folio})` : ''}`,
			'Solicita un CAF nuevo en sii.cl y cárgalo en Odoo; después confirma allí los borradores que quedaron sin folio',
			'none',
			raw
		);
	}
	const rejection = type === 'electronic_rejection' || type === 'emit_electronic_exception' || has(/cfdi|al pac|timbr/) ? electronicRejectionReason(raw) : null;

	if (rejection) {
		return build(
			'electronic_rejected',
			`El SAT rechazó el timbrado: ${rejection.reason.replace(/[.\s]+$/, '')}${rejection.code ? ` (${rejection.code})` : ''}`,
			'Corrige en Odoo los datos fiscales del cliente según su Constancia de Situación Fiscal y vuelve a timbrar desde Odoo',
			'client_entity',
			raw
		);
	}
	if (has(/odoo_partner_id|client_entity_id|partner|no tiene cliente configurado en odoo|res\.partner|razon social no esta vinculada/)) {
		return build(
			'partner_not_linked',
			'La razón social no está vinculada en Odoo',
			'Vincúlala en Clientes › Razones sociales y vuelve a enviarla',
			'client_entity',
			raw
		);
	}
	if (has(/lock date|fecha de bloqueo|periodo (contable )?cerrado|closed period|locked period|period is (closed|locked)|bloqueo de/)) {
		return build(
			'period_closed',
			'El período contable de la fecha de emisión está cerrado en Odoo',
			'Pide a contabilidad abrir el período en Odoo o reprograma la fecha de emisión',
			'reschedule',
			raw
		);
	}
	if (has(/duplicad|duplicate|already exists|ya existe|unique constraint|must be unique|debe ser unico|folio.*(usado|existe)/)) {
		return build(
			'duplicate_number',
			'Ya existe en Odoo un documento con ese número o folio',
			'Revisa en Odoo si la factura ya se creó; si es así, regístrala como emitida en vez de reenviarla',
			'open_invoice',
			raw
		);
	}
	if (has(/currenc|moneda|res\.currency/) && has(/inactiv|not active|no esta activ|archiv|disabled|deshabilit|no existe|not found|no encontrad/)) {
		return build(
			'currency_inactive',
			'La moneda de la factura no está activa en Odoo',
			'Activa la moneda en Odoo (Contabilidad › Monedas) y vuelve a enviarla',
			'integrations',
			raw
		);
	}
	if (has(/journal|diario/)) {
		return build(
			'journal_missing',
			'Falta el diario de ventas en Odoo para la compañía emisora',
			'Configura el diario de ventas de la compañía en Odoo y vuelve a enviarla',
			'integrations',
			raw
		);
	}
	if (type === 'tax_validation' || has(/\btax|impuesto|account\.tax/)) {
		return build(
			'tax_not_found',
			'Un impuesto de la factura no existe en Odoo o no corresponde a la compañía emisora',
			'Revisa los impuestos del producto y de la compañía en Integraciones › ERP › Mapeos',
			'integrations',
			raw
		);
	}
	if (
		has(
			/timeout|timed out|econnrefused|econnreset|enotfound|etimedout|socket hang up|network|fallo la autenticacion con odoo|conexion odoo|no se pudo obtener la conexion|\b50[234]\b|service unavailable|bad gateway/
		)
	) {
		return build(
			'connection',
			'No pudimos conectarnos con Odoo',
			'Vuelve a intentarlo en unos minutos; si sigue fallando, revisa la conexión en Integraciones › ERP › Configuración',
			'retry',
			raw
		);
	}
	if (has(/odoo_integration_id/)) {
		return build(
			'validation',
			'La compañía emisora no tiene integración con Odoo',
			'Relaciona la compañía en Integraciones › ERP › Mapeos',
			'integrations',
			raw
		);
	}
	if (has(/reference_date|referencias sin/)) {
		return build(
			'validation',
			'Una referencia (OC/HES) no tiene fecha y el ERP la exige',
			'Agrega la fecha a la referencia y vuelve a enviarla',
			'references',
			raw
		);
	}
	if (has(/no tiene items|sin lineas|no tiene lineas/)) {
		return build('validation', 'La factura no tiene líneas', 'Agrega líneas a la factura antes de enviarla', 'open_invoice', raw);
	}
	if (
		type === 'validation' ||
		type === 'odoo_rejection' ||
		has(/validation|validacion|usererror|required|obligatori|invalid|invalido|no es valido/)
	) {
		const clean = cleanErpMessage(raw);

		return build(
			'validation',
			clean ? `Odoo rechazó la factura: ${clean}` : 'Odoo rechazó la factura',
			'Corrige el dato indicado y vuelve a enviarla',
			'open_invoice',
			raw
		);
	}

	// Sin categoría: la primera frase útil del error de Odoo (Domi 28-10: el texto real existía y no se veía), no la frase genérica.
	const clean = cleanErpMessage(raw);

	return build(
		'unknown',
		clean ? `El ERP respondió: ${clean}` : 'No se pudo enviar la factura al ERP',
		'Revisa el detalle técnico o vuelve a intentarlo en unos minutos',
		'none',
		raw
	);
}

/** Frase completa (mensaje + paso siguiente) para toasts y notificaciones. */
export const erpErrorSentence = (translation: Pick<ErpErrorTranslation, 'message' | 'next_step'>) =>
	`${translation.message.replace(/[.\s]+$/, '')}. ${translation.next_step.replace(/[.\s]+$/, '')}.`;
