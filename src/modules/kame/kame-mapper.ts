/**
 * Cuerpos de la API de Kame armados desde lo que Sapira ya emitió (lógica pura, sin Nest ni base):
 * - la venta (`addVenta`) o la nota de crédito (`addNotaCredito`) sale del **XML del DTE emitido** por api-factura, así el folio, los
 *   montos, la forma de pago y el receptor son exactamente los que recibió el SII (Kame valida IVA y total al peso);
 * - el comprobante (`addComprobante`) sale de un mes de asientos de devengo (`RevenueMetricsService.journal`) con los códigos de cuenta
 *   del ERP de la compañía (`company_account_mappings.external_*_code`).
 */
import { XMLParser } from 'fast-xml-parser';

import { formatKameRut, KAME_DOCUMENT_NAMES } from './kame.types';

/** Error de armado: el registro no se puede enviar tal como está (falta un dato o no cuadra). No se reintenta solo. */
export class KameMappingError extends Error {
	constructor(
		message: string,
		readonly code: string
	) {
		super(message);
		this.name = 'KameMappingError';
	}
}

// ── DTE emitido (XML del SII) ───────────────────────────────────────────────────────────────────────────────────────────────

export interface DteLine {
	nombre: string;
	descripcion: string | null;
	cantidad: number;
	precio: number;
	descuento: number;
	monto: number;
	exento: boolean;
	unidad: string | null;
}

export interface DteReference {
	tipo: string;
	folio: string;
	fecha: string;
	codigo: number | null;
	razon: string | null;
}

/** Lo que Kame necesita de un DTE emitido, leído de su XML. */
export interface IssuedDte {
	tipo: number;
	folio: number;
	fechaEmision: string;
	formaPago: number | null;
	fechaVencimiento: string | null;
	receptor: {
		rut: string;
		razonSocial: string;
		giro: string;
		direccion: string;
		comuna: string;
		ciudad: string;
		correo: string;
	};
	neto: number;
	exento: number;
	iva: number;
	total: number;
	lineas: DteLine[];
	referencias: DteReference[];
}

const asArray = <T>(value: T | T[] | undefined | null): T[] => (value == null ? [] : Array.isArray(value) ? value : [value]);
const text = (value: unknown) => (value == null ? '' : String(value).trim());
const num = (value: unknown) => {
	const parsed = Number(text(value));

	return Number.isFinite(parsed) ? parsed : 0;
};

/** Busca el primer nodo `Documento` (el XML puede ser un `DTE` suelto o un `EnvioDTE`). */
function findDocumento(node: unknown): Record<string, unknown> | null {
	if (!node || typeof node !== 'object') return null;
	const record = node as Record<string, unknown>;

	if (record.Documento && typeof record.Documento === 'object') {
		return asArray(record.Documento as Record<string, unknown> | Record<string, unknown>[])[0] ?? null;
	}
	for (const value of Object.values(record)) {
		const found = findDocumento(Array.isArray(value) ? value[0] : value);

		if (found) return found;
	}

	return null;
}

/** Lee el XML de un DTE emitido (formato SII 2.5) y devuelve lo que se registra en Kame. */
export function parseIssuedDte(xml: string | Buffer): IssuedDte {
	const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, removeNSPrefix: true, trimValues: true });
	const documento = findDocumento(parser.parse(typeof xml === 'string' ? xml : xml.toString('latin1')));

	if (!documento) throw new KameMappingError('El XML del documento no trae un nodo Documento', 'dte_xml_invalid');
	const encabezado = (documento.Encabezado ?? {}) as Record<string, Record<string, unknown>>;
	const idDoc = encabezado.IdDoc ?? {};
	const receptor = encabezado.Receptor ?? {};
	const totales = encabezado.Totales ?? {};
	const tipo = num(idDoc.TipoDTE);

	if (!KAME_DOCUMENT_NAMES[tipo]) throw new KameMappingError(`Kame no recibe documentos tipo ${tipo || '(sin tipo)'}`, 'dte_type_unsupported');

	return {
		tipo,
		folio: num(idDoc.Folio),
		fechaEmision: text(idDoc.FchEmis),
		formaPago: idDoc.FmaPago == null ? null : num(idDoc.FmaPago),
		fechaVencimiento: text(idDoc.FchVenc) || null,
		receptor: {
			rut: text(receptor.RUTRecep),
			razonSocial: text(receptor.RznSocRecep),
			giro: text(receptor.GiroRecep),
			direccion: text(receptor.DirRecep),
			comuna: text(receptor.CmnaRecep),
			ciudad: text(receptor.CiudadRecep),
			correo: text(receptor.CorreoRecep),
		},
		neto: num(totales.MntNeto),
		exento: num(totales.MntExe),
		iva: num(totales.IVA),
		total: num(totales.MntTotal),
		lineas: asArray(documento.Detalle as Record<string, unknown>[]).map((linea) => ({
			nombre: text(linea.NmbItem),
			descripcion: text(linea.DscItem) || null,
			cantidad: linea.QtyItem == null ? 1 : num(linea.QtyItem),
			precio: linea.PrcItem == null ? num(linea.MontoItem) : num(linea.PrcItem),
			descuento: num(linea.DescuentoMonto),
			monto: num(linea.MontoItem),
			exento: text(linea.IndExe) === '1',
			unidad: text(linea.UnmdItem) || null,
		})),
		referencias: asArray(documento.Referencia as Record<string, unknown>[]).map((ref) => ({
			tipo: text(ref.TpoDocRef),
			folio: text(ref.FolioRef),
			fecha: text(ref.FchRef),
			codigo: ref.CodRef == null ? null : num(ref.CodRef),
			razon: text(ref.RazonRef) || null,
		})),
	};
}

// ── Venta y nota de crédito ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface KameSaleContext {
	/** Correo del usuario de Kame (campo `Usuario`). */
	usuario: string;
	unidadNegocio: string | null;
	sucursal: string | null;
	/** Glosa del documento en Kame (p. ej. «Contrato CTR-2026-81 · Sapira»). */
	comentario: string;
}

const kameDate = (date: string) => `${date.slice(0, 10)}T00:00:00`;

/**
 * Línea de Kame: `Total` debe ser cantidad × precio − descuento. Si la cantidad y el precio del DTE no dan el monto exacto (precio
 * unitario con decimales), la línea va como 1 × monto y la cantidad original queda en la descripción detallada: el monto manda.
 */
function kameLine(line: DteLine, context: KameSaleContext) {
	// Exacto al peso (con margen solo para el error de punto flotante): Kame recalcula la línea y no se sabe cómo redondea.
	const exact = Math.abs(line.cantidad * line.precio - line.descuento - line.monto) < 0.005;
	const detail = [line.descripcion, exact ? null : `Cantidad ${line.cantidad} × ${line.precio}`].filter(Boolean).join(' · ');

	return {
		Descripcion: line.nombre.slice(0, 80),
		Cantidad: exact ? line.cantidad : 1,
		PrecioUnitario: exact ? line.precio : line.monto,
		Descuento: exact ? line.descuento : 0,
		Total: line.monto,
		UnidadMedida: (line.unidad ?? 'UN').slice(0, 4),
		UnidadNegocio: context.unidadNegocio ?? '',
		Articulo: '',
		PorcDescuento: 0,
		DescripcionDetallada: detail,
		Exento: line.exento ? 'S' : '',
		TipoExento: line.exento ? '1' : '',
		CuentaEmpresaVenta: '',
		TipoArticulo: 'SERVICIO',
	};
}

/** Kame valida IVA = Σ líneas afectas × 0,19 y total = afecto + exento + IVA; se revisa antes de enviar para no gastar un intento. */
export function assertKameTotals(dte: IssuedDte): void {
	const afecto = dte.lineas.filter((line) => !line.exento).reduce((sum, line) => sum + line.monto, 0);
	const exento = dte.lineas.filter((line) => line.exento).reduce((sum, line) => sum + line.monto, 0);

	if (Math.abs(afecto - dte.neto) > 5) {
		throw new KameMappingError(`Las líneas afectas suman ${afecto} y el neto del documento es ${dte.neto}`, 'amounts_mismatch');
	}
	if (exento !== dte.exento) {
		throw new KameMappingError(`Las líneas exentas suman ${exento} y el exento del documento es ${dte.exento}`, 'amounts_mismatch');
	}
	if (Math.round(dte.neto * 0.19) !== dte.iva) {
		throw new KameMappingError(`El IVA del documento (${dte.iva}) no es el 19 % del neto (${dte.neto}) como lo valida Kame`, 'vat_mismatch');
	}
	if (dte.neto + dte.exento + dte.iva !== dte.total) {
		throw new KameMappingError(`El total del documento (${dte.total}) no es neto + exento + IVA`, 'total_mismatch');
	}
}

const paymentOf = (dte: IssuedDte) => {
	const credit = dte.formaPago === 2;
	const due = dte.fechaVencimiento ?? dte.fechaEmision;

	return {
		FormaPago: credit ? '2' : '1',
		FechaVencimiento: kameDate(due),
		Cuotas: credit ? [{ FechaPago: kameDate(due), MontoPago: dte.total }] : [],
	};
};

const referencesOf = (dte: IssuedDte) =>
	dte.referencias
		.filter((ref) => ref.folio)
		.map((ref) => ({
			TpoDocRef: KAME_DOCUMENT_NAMES[Number(ref.tipo)] ?? ref.tipo,
			FolioRef: ref.folio,
			...(ref.codigo != null ? { CodRef: ref.codigo } : {}),
			FechaRef: kameDate(ref.fecha || dte.fechaEmision),
			RazonRef: ref.razon ?? '',
		}));

/** `addVenta` de una factura (33), factura exenta (34) o nota de débito (56) emitida en Sapira, con su folio. */
export function saleBody(dte: IssuedDte, context: KameSaleContext) {
	if (dte.tipo === 61) throw new KameMappingError('Una nota de crédito va por addNotaCredito', 'dte_type_unsupported');
	if (!dte.folio) throw new KameMappingError('El documento no tiene folio', 'missing_folio');
	assertKameTotals(dte);

	return {
		Usuario: context.usuario,
		Documento: KAME_DOCUMENT_NAMES[dte.tipo],
		Sucursal: context.sucursal ?? '',
		Rut: formatKameRut(dte.receptor.rut),
		TipoDocumento: 'VENTA',
		Folio: String(dte.folio),
		RznSocial: dte.receptor.razonSocial,
		Giro: dte.receptor.giro,
		Direccion: dte.receptor.direccion,
		Ciudad: dte.receptor.ciudad || dte.receptor.comuna,
		Comuna: dte.receptor.comuna,
		Telefono: '',
		Email: dte.receptor.correo,
		Fecha: kameDate(dte.fechaEmision),
		Comentario: context.comentario,
		...paymentOf(dte),
		Afecto: dte.neto,
		Exento: dte.exento,
		Descuento: 0,
		TipoImpto1: 'IVA',
		ValorImpto1: dte.iva,
		total: dte.total,
		Bodega: '',
		EsInventariable: '',
		Vendedor: '',
		Recargo: 0,
		PorcDescuento: 0,
		PorcRecargo: 0,
		Contacto: '',
		Comision: null,
		FormaCredito: '',
		FichaDireccion: '',
		CuentaEmpresaCliente: '',
		RutTransporte: '',
		RutChofer: '',
		NombreChofer: '',
		Patente: '',
		Detalle: dte.lineas.map((line) => kameLine(line, context)),
		Referencias: referencesOf(dte),
	};
}

/** `addNotaCredito` de una nota de crédito (61) emitida en Sapira: siempre con la referencia al documento que corrige. */
export function creditNoteBody(dte: IssuedDte, context: KameSaleContext) {
	if (dte.tipo !== 61) throw new KameMappingError('Solo una nota de crédito va por addNotaCredito', 'dte_type_unsupported');
	if (!dte.folio) throw new KameMappingError('El documento no tiene folio', 'missing_folio');
	const referencias = referencesOf(dte);

	if (referencias.length === 0) {
		throw new KameMappingError('La nota de crédito no trae la referencia al documento que corrige', 'missing_reference');
	}
	assertKameTotals(dte);

	return {
		Usuario: context.usuario,
		Documento: KAME_DOCUMENT_NAMES[61],
		Sucursal: context.sucursal ?? '',
		Rut: formatKameRut(dte.receptor.rut),
		TipoDocumento: 'VENTA',
		Folio: String(dte.folio),
		Fecha: kameDate(dte.fechaEmision),
		Comentario: context.comentario,
		...paymentOf(dte),
		Afecto: dte.neto,
		Exento: dte.exento,
		Descuento: 0,
		Recargo: 0,
		TipoImpto1: 'IVA',
		ValorImpto1: dte.iva,
		Total: dte.total,
		PorcDescuento: 0,
		PorcRecargo: 0,
		Detalle: dte.lineas.map((line) => kameLine(line, context)),
		Referencias: referencias,
	};
}

/** Cuerpo y endpoint de Kame para un DTE emitido. */
export function documentRequest(dte: IssuedDte, context: KameSaleContext) {
	return dte.tipo === 61
		? { endpoint: '/Documento/addNotaCredito' as const, body: creditNoteBody(dte, context) }
		: { endpoint: '/Documento/addVenta' as const, body: saleBody(dte, context) };
}

// ── Comprobante de devengo ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Una pierna del asiento tal como la devuelve `RevenueMetricsService.journal` (con la cuenta de la compañía ya resuelta). */
export interface JournalPostingInput {
	account: string;
	debit: number;
	credit: number;
	name: string | null;
	external_code: string | null;
}

export interface JournalMonthInput {
	period: string;
	postings: JournalPostingInput[];
}

export interface KameJournalContext {
	usuario: string;
	unidadNegocio: string | null;
	/** Glosa del comprobante (p. ej. «Devengo de ingresos 2026-09 · Sapira»). */
	comentario: string;
}

/** Último día del mes `YYYY-MM-01`: fecha del comprobante de devengo. */
export function lastDayOfMonth(period: string): string {
	const [year, month] = period.slice(0, 7).split('-').map(Number);
	const last = new Date(Date.UTC(year, month, 0)).getUTCDate();

	return `${period.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

/**
 * `addComprobante` (TRASPASO) de un mes de devengo, en pesos enteros. Cada pierna llega en pares debe = haber del mismo monto, así que
 * redondear cada una deja el comprobante cuadrado; se suma por cuenta y lado (una línea de debe y una de haber por cuenta). Falla si una
 * cuenta con movimiento no tiene código del ERP o si el mes no cuadra.
 */
export function journalBody(month: JournalMonthInput, context: KameJournalContext) {
	const missing = [...new Set(month.postings.filter((posting) => !posting.external_code).map((posting) => posting.name ?? posting.account))];

	if (missing.length > 0) {
		throw new KameMappingError(`Faltan los códigos del ERP de estas cuentas: ${missing.join(', ')}`, 'missing_account_code');
	}
	const totals = new Map<string, { code: string; name: string; debit: number; credit: number }>();

	for (const posting of month.postings) {
		const code = posting.external_code!;
		const bucket = totals.get(code) ?? { code, name: posting.name ?? posting.account, debit: 0, credit: 0 };

		bucket.debit += Math.round(posting.debit);
		bucket.credit += Math.round(posting.credit);
		totals.set(code, bucket);
	}
	const fecha = lastDayOfMonth(month.period);
	const detalle = [...totals.values()].flatMap((account) =>
		[
			{ debe: account.debit, haber: 0 },
			{ debe: 0, haber: account.credit },
		]
			.filter((side) => side.debe + side.haber > 0)
			.map((side) => ({
				cuenta: account.code,
				debe: side.debe,
				haber: side.haber,
				comentario: `${context.comentario} · ${account.name}`.slice(0, 200),
				rutFicha: '',
				documento: '',
				folioDocumento: '',
				unidadNegocio: context.unidadNegocio ?? '',
				fechaVencimiento: '',
				tipoMovimiento: '',
				numeroMovimiento: '',
			}))
	);
	const debe = detalle.reduce((sum, line) => sum + line.debe, 0);
	const haber = detalle.reduce((sum, line) => sum + line.haber, 0);

	if (detalle.length === 0) throw new KameMappingError('El mes no tiene movimientos de devengo', 'empty_journal');
	if (debe !== haber) throw new KameMappingError(`El comprobante no cuadra: debe ${debe} y haber ${haber}`, 'journal_unbalanced');

	return { usuario: context.usuario, tipoComprobante: 'TRASPASO', folio: '', fecha, comentario: context.comentario, detalle };
}
