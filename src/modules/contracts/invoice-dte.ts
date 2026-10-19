import { isCreditNote } from './contract-360';

import type { ContractInvoiceRow, InvoiceBlocker, InvoiceWarning } from './contract-invoices';

/**
 * Emisión de facturas, notas de crédito y notas de débito como documentos tributarios electrónicos (DTE) del SII con el servicio de
 * facturación electrónica (api-factura), para las compañías chilenas que emiten sin ERP. Lógica pura: tipo de documento, montos en
 * pesos enteros, cuerpo del DTE (`dteBody` de api-factura) y bloqueos. El servicio (`contract-invoice-dte.service.ts`) carga, llama a
 * api-factura y escribe. Diseño: `front-lenosoft/app/docs/content/api-factura/proyecto/diseno-facturacion-sapira.md`.
 */

/** Estados del DTE guardados en `invoices.dte_status`. */
export const DTE_STATUSES = ['creado', 'enviado', 'aceptado', 'reparos', 'rechazado'] as const;
export type DteStatus = (typeof DTE_STATUSES)[number];

/** Con estos el documento ya vale ante el SII: se entrega al receptor y sirve de referencia para una nota. */
export const DTE_VALID_STATUSES: readonly DteStatus[] = ['aceptado', 'reparos'];

export const DTE_TYPES = { invoice: 33, exempt_invoice: 34, debit_note: 56, credit_note: 61 } as const;
export type DteTipo = (typeof DTE_TYPES)[keyof typeof DTE_TYPES];

export const DTE_TYPE_LABELS: Record<number, string> = {
	33: 'Factura electrónica',
	34: 'Factura no afecta o exenta electrónica',
	56: 'Nota de débito electrónica',
	61: 'Nota de crédito electrónica',
};

/** Largos máximos de DTE_v10.xsd que la API corta antes de enviar (el resto lo valida api-factura contra el XSD). */
export const DTE_LIMITS = { razon_social: 100, giro: 40, direccion: 70, comuna: 20, nombre_item: 80, descripcion_item: 1000, razon_ref: 90 } as const;

/** Tipos de referencia de `billing_references` que viajan al DTE: orden de compra (801) y hoja de entrada de servicios (HES). */
const BILLING_REFERENCE_DTE_CODES: Record<string, string> = { PO: '801', OC: '801', HES: 'HES' };

export const isDebitNote = (documentType: string | null | undefined) => documentType === 'ND';

/** Redondeo al entero con 0,5 hacia arriba, igual que api-factura (`dte-montos.ts`), para que los montos cuadren allá. */
export function roundClp(value: number): number {
	return Math.sign(value) * Math.round(Math.abs(value) + Number.EPSILON);
}

/** RUT sin puntos ni espacios, con guion y dígito verificador en mayúscula (`76.120.605-2` → `76120605-2`). null si no tiene forma de RUT. */
export function normalizeRut(value: string | null | undefined): string | null {
	const clean = String(value ?? '')
		.replace(/[.\s]/g, '')
		.toUpperCase();
	const match = clean.match(/^(\d{1,9})-?([\dK])$/);

	return match ? `${Number(match[1])}-${match[2]}` : null;
}

/** Dígito verificador de un cuerpo de RUT (módulo 11). */
export function rutCheckDigit(body: string): string {
	let sum = 0;
	let factor = 2;

	for (const digit of body.split('').reverse()) {
		sum += Number(digit) * factor;
		factor = factor === 7 ? 2 : factor + 1;
	}
	const rest = 11 - (sum % 11);

	return rest === 11 ? '0' : rest === 10 ? 'K' : String(rest);
}

/** RUT con forma válida y dígito verificador correcto (el SII rechaza un DTE con un RUT de dígito mal escrito). */
export function isValidRut(value: string | null | undefined): boolean {
	const rut = normalizeRut(value);
	if (!rut) return false;
	const [body, digit] = rut.split('-');

	return rutCheckDigit(body) === digit;
}

const cut = (value: string | null | undefined, max: number) => {
	const text = String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();

	return text ? text.slice(0, max) : undefined;
};

/**
 * Tipo SII del documento: NC → 61, ND → 56; factura → 34 si va sin IVA (tasa 0 o el contrato es 34), si no 33. La factura de exportación
 * (110 y sus notas 111/112) no se emite por este camino: null.
 */
export function dteTipoFor(
	invoice: Pick<ContractInvoiceRow, 'document_type' | 'tax_rate'>,
	contractDocumentCode: string | null | undefined
): DteTipo | null {
	if (invoice.document_type === 'FACTURA_EXPORTACION' || contractDocumentCode === '110') return null;
	if (isCreditNote(invoice.document_type)) return DTE_TYPES.credit_note;
	if (isDebitNote(invoice.document_type)) return DTE_TYPES.debit_note;
	if (contractDocumentCode === '34' || invoice.tax_rate === 0) return DTE_TYPES.exempt_invoice;

	return DTE_TYPES.invoice;
}

export interface DteSourceLine {
	id: string;
	description: string | null;
	quantity: number;
	unit_of_measure: string | null;
	/** Subtotal neto de la línea en moneda de factura (CLP), ya valorizado; en NC viene negativo. */
	subtotal_invoice_currency: number;
	/** Subtotal en la moneda del contrato (p. ej. UF) cuando se convierte a pesos; null si es la misma moneda. Va en la nota de la línea. */
	contract_amount?: number | null;
}

export interface DteLineAmount {
	id: string;
	description: string | null;
	quantity: number;
	unit_of_measure: string | null;
	/** Neto de la línea en pesos enteros, siempre positivo (el DTE no admite montos negativos: la NC los lleva en positivo). */
	monto: number;
	contract_amount?: number | null;
}

export interface DteAmounts {
	lines: DteLineAmount[];
	neto: number;
	exento: number;
	iva: number;
	total: number;
	tasa: number;
}

/**
 * Montos del DTE en pesos enteros: cada línea redondeada, con el residuo de redondear (Σ redondeada ≠ redondeo de la Σ) en la línea
 * más grande, para que el neto sea el redondeo del total exacto. IVA = redondeo(neto × tasa / 100) y total = neto + IVA, como calcula
 * api-factura (si no cuadran, rechaza antes de gastar el folio). Sin IVA (34) todo va exento. Las NC llegan negativas y salen positivas.
 */
export function dteAmounts(lines: DteSourceLine[], taxRate: number, exempt: boolean): DteAmounts {
	const absolute = lines.map((line) => Math.abs(line.subtotal_invoice_currency));
	const montos = absolute.map((value) => roundClp(value));

	if (lines.length) {
		let largest = 0;

		absolute.forEach((value, index) => {
			if (value > absolute[largest]) largest = index;
		});
		montos[largest] += roundClp(absolute.reduce((sum, value) => sum + value, 0)) - montos.reduce((sum, value) => sum + value, 0);
	}
	const base = montos.reduce((sum, value) => sum + value, 0);
	const tasa = exempt ? 0 : taxRate;
	const iva = exempt ? 0 : roundClp((base * tasa) / 100);

	return {
		lines: lines.map((line, index) => ({
			id: line.id,
			description: line.description,
			quantity: Math.abs(line.quantity) || 1,
			unit_of_measure: line.unit_of_measure,
			monto: montos[index],
			contract_amount: line.contract_amount === null || line.contract_amount === undefined ? null : Math.abs(line.contract_amount),
		})),
		neto: exempt ? 0 : base,
		exento: exempt ? base : 0,
		iva,
		total: base + iva,
		tasa,
	};
}

/** IVA del documento repartido en las líneas (cada una a la tasa, el residuo en la más grande) para que Σ IVA de líneas = IVA del DTE. */
export function distributeTax(amounts: DteAmounts): number[] {
	if (!amounts.iva) return amounts.lines.map(() => 0);
	const taxes = amounts.lines.map((line) => Math.round((line.monto * amounts.tasa) / 100));
	let largest = 0;

	amounts.lines.forEach((line, index) => {
		if (line.monto > amounts.lines[largest].monto) largest = index;
	});
	taxes[largest] += amounts.iva - taxes.reduce((sum, value) => sum + value, 0);

	return taxes;
}

export interface DteReceptor {
	tax_id: string | null;
	legal_name: string | null;
	economic_activity: string | null;
	legal_address: string | null;
	commune: string | null;
	/** «Correo (DTE)» de la razón social: ahí se entrega cada documento. */
	email: string | null;
}

export interface DteReference {
	/** Código SII del documento referenciado (33, 34, 801 = OC, HES…). */
	document_type_code: string;
	document_number: string;
	reference_date: string | null;
	/** 1 anula, 2 corrige texto, 3 corrige montos (solo notas). */
	reference_code: number | null;
	reason: string | null;
}

/** Correo al que se entrega el DTE: el «Correo (DTE)» de la razón social (`client_entities.email`). */
export const receptorEmailOf = (receptor: Pick<DteReceptor, 'email'>): string | null => receptor.email?.trim() || null;

/** Unidad de medida del SII (hasta 4 caracteres). */
const unit = (value: string | null) => cut(value, 4);

/**
 * Cuerpo de `POST /dte/createDte` de api-factura (`dteBody`), sin `Emisor` (api-factura lo arma con los datos del emisor de la compañía)
 * ni folio (lo asigna api-factura). La glosa va en `NmbItem` (80) y lo que sobra en `DscItem`. Cantidad y precio solo si reproducen el
 * monto de la línea al peso, como lo verifica api-factura; si no, la línea lleva solo su monto.
 */
/** Tipo de cambio con que se pasó la factura a pesos: la nota de cada línea lo muestra al cliente. */
export interface DteFxNote {
	rate: number;
	/** Moneda del contrato (`CLF`, `USD`…). */
	currency: string;
	/** Día de la tasa oficial usada; null si es la tasa fija de la factura. */
	date: string | null;
}

/** Nombre corto de la moneda en la nota: la UF (`CLF`) se escribe «UF». */
const currencyLabel = (currency: string) => (currency.toUpperCase() === 'CLF' ? 'UF' : currency.toUpperCase());

/**
 * Nota de la línea con el valor en la moneda del contrato y la tasa: «Valor: 20 UF × $41.178,64 (UF del 18-10-2026)». Así el cliente ve
 * de dónde sale el monto en pesos. Con la tasa fija de la factura: «(tipo de cambio de la factura)».
 */
export function fxLineNote(amount: number, fx: DteFxNote): string {
	const label = currencyLabel(fx.currency);
	const quantity = amount.toLocaleString('es-CL', { maximumFractionDigits: 4 });
	const rate = fx.rate.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	const [year, month, day] = (fx.date ?? '').slice(0, 10).split('-');
	const source = fx.date && day ? `${label} del ${day}-${month}-${year}` : 'tipo de cambio de la factura';

	return `Valor: ${quantity} ${label} × $${rate} (${source})`;
}

export function mapInvoiceToDteBody(input: {
	tipo: DteTipo;
	issue_date: string;
	due_date: string | null;
	receptor: DteReceptor;
	amounts: DteAmounts;
	references: DteReference[];
	/** Con conversión (contrato en UF u otra moneda): cada línea lleva en su descripción el valor en esa moneda y la tasa. */
	fx?: DteFxNote | null;
}): Record<string, unknown> {
	const { tipo, amounts, receptor } = input;
	const exempt = tipo === DTE_TYPES.exempt_invoice;
	const note = tipo === DTE_TYPES.credit_note || tipo === DTE_TYPES.debit_note;
	const credit = !!input.due_date && input.due_date > input.issue_date;

	const Detalle = amounts.lines.map((line, index) => {
		const text = (line.description ?? '').replace(/\s+/g, ' ').trim() || `Línea ${index + 1}`;
		const price = Math.round((line.monto / line.quantity) * 1e6) / 1e6;
		const reproducible = roundClp(line.quantity * price) === line.monto;
		// Descripción adicional: el texto que no cabe en el nombre (80) y la nota del tipo de cambio, si la factura se convirtió.
		const description = [
			text.length > DTE_LIMITS.nombre_item ? text : null,
			input.fx && line.contract_amount ? fxLineNote(line.contract_amount, input.fx) : null,
		]
			.filter(Boolean)
			.join(' · ')
			.slice(0, DTE_LIMITS.descripcion_item);

		return {
			NroLinDet: index + 1,
			NmbItem: text.slice(0, DTE_LIMITS.nombre_item),
			...(description ? { DscItem: description } : {}),
			...(exempt ? { IndExe: 1 } : {}),
			...(reproducible ? { QtyItem: line.quantity, PrcItem: price } : {}),
			...(reproducible && unit(line.unit_of_measure) ? { UnmdItem: unit(line.unit_of_measure) } : {}),
			MontoItem: line.monto,
		};
	});

	const Referencia = input.references.map((reference, index) => ({
		NroLinRef: index + 1,
		TpoDocRef: reference.document_type_code,
		FolioRef: String(reference.document_number).slice(0, 18),
		FchRef: (reference.reference_date ?? input.issue_date).slice(0, 10),
		...(note && reference.reference_code ? { CodRef: reference.reference_code } : {}),
		...(reference.reason ? { RazonRef: cut(reference.reason, DTE_LIMITS.razon_ref) } : {}),
	}));

	return {
		Encabezado: {
			IdDoc: {
				TipoDTE: tipo,
				FchEmis: input.issue_date,
				...(note ? {} : { FmaPago: credit ? 2 : 1 }),
				...(credit ? { FchVenc: input.due_date } : {}),
			},
			Receptor: {
				RUTRecep: normalizeRut(receptor.tax_id),
				RznSocRecep: cut(receptor.legal_name, DTE_LIMITS.razon_social),
				GiroRecep: cut(receptor.economic_activity, DTE_LIMITS.giro),
				DirRecep: cut(receptor.legal_address, DTE_LIMITS.direccion),
				CmnaRecep: cut(receptor.commune, DTE_LIMITS.comuna),
			},
			Totales: exempt
				? { MntExe: amounts.exento, MntTotal: amounts.total }
				: { MntNeto: amounts.neto, TasaIVA: amounts.tasa, IVA: amounts.iva, MntTotal: amounts.total },
		},
		Detalle,
		...(Referencia.length ? { Referencia } : {}),
	};
}

/** Referencias de la factura al DTE: las de la factura (`invoice_references`) y las del contrato (`billing_references`: OC y HES). */
export function dteReferencesOf(
	invoiceReferences: Array<{
		document_type_code: string | null;
		document_number: string | null;
		reference_date: string | null;
		reference_code: string | null;
		reason: string | null;
	}>,
	billingReferences: Array<{ reference_type: string | null; reference_code: string | null; issue_date: string | null }>
): DteReference[] {
	const own = invoiceReferences
		.filter((reference) => reference.document_type_code && reference.document_number)
		.map((reference) => ({
			document_type_code: String(reference.document_type_code),
			document_number: String(reference.document_number),
			reference_date: reference.reference_date,
			reference_code: Number(reference.reference_code) || null,
			reason: reference.reason,
		}));
	const linked = billingReferences
		.filter((reference) => BILLING_REFERENCE_DTE_CODES[String(reference.reference_type).toUpperCase()] && reference.reference_code)
		.map((reference) => ({
			document_type_code: BILLING_REFERENCE_DTE_CODES[String(reference.reference_type).toUpperCase()],
			document_number: String(reference.reference_code),
			reference_date: reference.issue_date,
			reference_code: null,
			reason: null,
		}));
	const seen = new Set<string>();

	return [...own, ...linked].filter((reference) => {
		const key = `${reference.document_type_code}|${reference.document_number}`;

		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

// ---------------------------------------------------------------- plan

export interface DteContext {
	/** La compañía tiene facturación electrónica activa (`sii_configurations.is_enabled`). */
	has_electronic_invoicing: boolean;
	/** La compañía tiene ERP: emite el ERP, no este camino (un emisor por compañía). */
	has_erp_integration: boolean;
	/** Código SII del documento del contrato (`tax_document_types.code`). */
	contract_document_code: string | null;
	today: string;
}

/** Lo que el DTE de una nota necesita de su documento original. */
export interface DteOriginal {
	id: string;
	invoice_number: string | null;
	issue_date: string | null;
	dte_tipo: number | null;
	dte_status: string | null;
}

export interface EmitDtePlan {
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
	can_apply: boolean;
	tipo: DteTipo | null;
	/** Ya tiene DTE creado (un intento anterior que no llegó al SII): se reintenta con el mismo documento y folio. */
	retry: boolean;
	/** El SII rechazó su DTE: se reemite como documento nuevo, con otro folio y la fecha de hoy. */
	reissue: boolean;
}

const blocker = (code: string, message: string, next_step: string | null): InvoiceBlocker => ({ code, message, next_step });

/** Bloqueos de los datos del receptor que exige el SII (RUT, razón social, giro, dirección y comuna). */
export function receptorDteBlockers(receptor: DteReceptor | null): InvoiceBlocker[] {
	if (!receptor) return [blocker('dte_receptor_missing', 'La factura no tiene razón social asignada', 'Asigna la razón social en el contrato')];
	const step = 'Complétalo en Clientes › Razones sociales';
	const blockers: InvoiceBlocker[] = [];

	if (!normalizeRut(receptor.tax_id))
		blockers.push(blocker('dte_receptor_tax_id', 'El RUT de la razón social falta o no tiene forma de RUT', step));
	else if (!isValidRut(receptor.tax_id))
		blockers.push(blocker('dte_receptor_tax_id', `El RUT ${receptor.tax_id} no es válido: revisa el dígito verificador`, step));
	if (!receptor.legal_name?.trim()) blockers.push(blocker('dte_receptor_legal_name', 'La razón social no tiene nombre legal', step));
	if (!receptor.economic_activity?.trim()) blockers.push(blocker('dte_receptor_giro', 'La razón social no tiene giro', step));
	if (!receptor.legal_address?.trim()) blockers.push(blocker('dte_receptor_address', 'La razón social no tiene dirección legal', step));
	if (!receptor.commune?.trim()) blockers.push(blocker('dte_receptor_commune', 'La razón social no tiene comuna', step));

	return blockers;
}

/**
 * Se puede emitir la factura o nota como DTE (spec del puente, fase 1 y 2)? Facturas: Por Emitir activas, sin borrador en el ERP, con
 * líneas y en pesos. Notas: pendientes de emisión, con su documento original ya emitido (folio) y, si ese se emitió como DTE, válido
 * ante el SII. Siempre: compañía con facturación electrónica y sin ERP, receptor completo y tipo soportado.
 */
export function planEmitDte(
	invoice: ContractInvoiceRow & { dte_id?: string | null; dte_status?: string | null },
	context: DteContext,
	input: { receptor: DteReceptor | null; base_blockers: InvoiceBlocker[]; original?: DteOriginal | null; pending_note?: boolean }
): EmitDtePlan {
	const reissue = isDteRejected(invoice);
	const blockers: InvoiceBlocker[] = [...input.base_blockers];
	const warnings: InvoiceWarning[] = [];
	const tipo = dteTipoFor(invoice, context.contract_document_code);
	const note = tipo === DTE_TYPES.credit_note || tipo === DTE_TYPES.debit_note;

	if (!context.has_electronic_invoicing) {
		blockers.push(
			blocker(
				'no_electronic_invoicing',
				'La compañía emisora no tiene la facturación electrónica activa',
				'Actívala en Administración › Compañía › Facturación electrónica'
			)
		);
	}
	if (context.has_erp_integration) {
		blockers.push(blocker('company_uses_erp', 'La compañía emite sus documentos en el ERP', 'Envíala al ERP'));
	}
	if (tipo === null) {
		blockers.push(
			blocker('unsupported_document_type', 'Las facturas de exportación todavía no se emiten como documento tributario desde Sapira', null)
		);
	}
	if ((invoice.invoice_currency ?? '').toUpperCase() !== 'CLP') {
		blockers.push(
			blocker(
				'dte_currency_not_clp',
				`La factura se emite en ${invoice.invoice_currency ?? 'sin moneda'}: el documento tributario va en pesos chilenos`,
				null
			)
		);
	}
	if (invoice.lines_count === 0) blockers.push(blocker('no_lines', 'La factura no tiene líneas', null));
	if (note && !input.pending_note && !reissue) {
		blockers.push(blocker('note_not_pending', 'La nota ya está emitida o no está pendiente de emisión', null));
	}
	if (note) {
		const original = input.original;

		if (!original) {
			blockers.push(blocker('note_without_original', 'La nota no está ligada a la factura que corrige', null));
		} else if (!original.invoice_number) {
			blockers.push(
				blocker('original_not_issued', 'La factura que corrige la nota todavía no tiene folio', 'Emite primero la factura original')
			);
		} else if (original.dte_status && !DTE_VALID_STATUSES.includes(original.dte_status as DteStatus)) {
			blockers.push(
				blocker(
					'original_not_accepted',
					`La factura ${original.invoice_number} todavía no está aceptada por el SII (${original.dte_status})`,
					'Consulta su estado en el SII y vuelve a intentarlo'
				)
			);
		}
	}
	if (invoice.dte_status && invoice.dte_status !== 'creado' && !reissue) {
		blockers.push(blocker('dte_already_issued', `Ya se emitió como documento tributario (estado: ${invoice.dte_status})`, null));
	}
	blockers.push(...receptorDteBlockers(input.receptor));
	if (input.receptor && !receptorEmailOf(input.receptor)) {
		warnings.push({
			code: 'dte_receptor_without_email',
			message: 'La razón social no tiene correo de intercambio: el documento no se le enviará por correo',
		});
	}
	if (input.receptor?.economic_activity && input.receptor.economic_activity.trim().length > DTE_LIMITS.giro) {
		warnings.push({ code: 'dte_giro_truncated', message: `El giro del receptor se acorta a ${DTE_LIMITS.giro} caracteres` });
	}
	if (invoice.issue_date && invoice.issue_date !== context.today && !note) {
		warnings.push({
			code: 'dte_issue_date_today',
			message: `El documento se emite con fecha de hoy (${context.today}), no con la programada (${invoice.issue_date})`,
		});
	}

	if (reissue) {
		warnings.push({
			code: 'dte_reissue',
			message: `El SII rechazó el documento${invoice.invoice_number ? ` N° ${invoice.invoice_number}` : ''}: se emite uno nuevo, con otro folio y fecha de hoy`,
		});
	}

	return { blockers, warnings, can_apply: blockers.length === 0, tipo, retry: !!invoice.dte_id && invoice.dte_status === 'creado', reissue };
}

/** Su DTE fue rechazado por el SII: se puede reemitir (documento nuevo, otro folio). */
export const isDteRejected = (invoice: { dte_id?: string | null; dte_status?: string | null }) =>
	!!invoice.dte_id && invoice.dte_status === 'rechazado';

/**
 * Cómo queda la factura para planear una reemisión: el folio rechazado no vale y una factura vuelve a estar Por Emitir (las notas
 * conservan su estado). Así le aplican las mismas reglas que a una primera emisión.
 */
export function asReissued<T extends { document_type?: string | null; status?: string | null; invoice_number?: string | null }>(
	invoice: T,
	note: boolean
): T {
	return { ...invoice, invoice_number: null, status: note ? invoice.status : 'Por Emitir' };
}

/** Estado guardado del DTE desde el resultado de la consulta al SII. */
export function dteStatusFromResultado(resultado: string): DteStatus {
	if (resultado === 'aceptado' || resultado === 'reparos' || resultado === 'rechazado') return resultado;

	return 'enviado';
}

// ---------------------------------------------------------------- nota de débito

/** Lo que una nota de débito necesita de la factura que corrige. */
export interface DebitNoteOriginal {
	id: string;
	status: string | null;
	document_type: string | null;
	is_active: boolean;
	invoice_number: string | null;
	issue_date: string | null;
	invoice_currency: string | null;
	tax_rate: number | null;
	dte_status: string | null;
}

export interface DebitNotePlan {
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
	can_apply: boolean;
	/** Neto, IVA y total de la nota en moneda de factura. */
	amount: number;
	vat: number;
	total: number;
	reason: string;
}

const NOTE_ISSUED_STATUSES = ['Emitida', 'Enviada', 'Vencida', 'Pagada'];

/**
 * Nota de débito (DTE 56) sobre una factura emitida: suma un neto (recargo, intereses, diferencia de precio) con el IVA de la factura y
 * la referencia `CodRef` 3 (corrige montos). Solo facturas emitidas, activas y con folio; si la factura se emitió como DTE, ya válida
 * ante el SII. Nace Emitida y queda pendiente de emisión hasta que se emita con «Emitir».
 */
export function planDebitNote(original: DebitNoteOriginal, input: { amount: number; reason: string }): DebitNotePlan {
	const blockers: InvoiceBlocker[] = [];
	const warnings: InvoiceWarning[] = [];

	if (isCreditNote(original.document_type) || isDebitNote(original.document_type)) {
		blockers.push(blocker('credit_note', 'Una nota de crédito o débito no se corrige con una nota de débito', 'Opera sobre la factura original'));
	} else if (!NOTE_ISSUED_STATUSES.includes(original.status ?? '') || !original.is_active) {
		blockers.push(
			blocker(
				'not_issued',
				`La factura no está emitida (estado: ${original.status ?? 'sin estado'})`,
				'Una Por Emitir se edita antes de emitir'
			)
		);
	}
	if (!original.invoice_number?.trim()) blockers.push(blocker('original_not_issued', 'La factura todavía no tiene folio', null));
	if (original.dte_status && !DTE_VALID_STATUSES.includes(original.dte_status as DteStatus)) {
		blockers.push(
			blocker(
				'original_not_accepted',
				`La factura todavía no está aceptada por el SII (${original.dte_status})`,
				'Consulta su estado en el SII'
			)
		);
	}
	const amount = Math.round(input.amount * 100) / 100;
	const vat = Math.round(((amount * (original.tax_rate ?? 0)) / 100) * 100) / 100;

	if (!(amount > 0)) blockers.push(blocker('invalid_amount', 'El monto debe ser mayor que 0', null));

	return {
		blockers,
		warnings,
		can_apply: blockers.length === 0,
		amount,
		vat,
		total: Math.round((amount + vat) * 100) / 100,
		reason: input.reason.trim(),
	};
}
