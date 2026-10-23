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
		.replace(/<Fault[^>]*>|Fault\s*\d*\s*:?/gi, '')
		.replace(/[\r\n]+/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.replace(/^["'\s(]+|["'\s)]+$/g, '')
		.trim();

	if (text.length > MAX_CLEAN) text = `${text.slice(0, MAX_CLEAN - 1).trimEnd()}…`;

	return text;
}

const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

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

	return build('unknown', 'No se pudo enviar la factura al ERP', 'Revisa el detalle técnico o vuelve a intentarlo en unos minutos', 'none', raw);
}

/** Frase completa (mensaje + paso siguiente) para toasts y notificaciones. */
export const erpErrorSentence = (translation: Pick<ErpErrorTranslation, 'message' | 'next_step'>) =>
	`${translation.message.replace(/[.\s]+$/, '')}. ${translation.next_step.replace(/[.\s]+$/, '')}.`;
