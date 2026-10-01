/**
 * Catálogo de documentos tributarios (`tax_document_types`) aplicado a un contrato: qué documentos puede emitir una
 * compañía según su país, cuál se sugiere frente a la razón social receptora y cómo se deriva la familia
 * `contracts.document_type`. Pieza pura (sin base de datos); la usan el formulario, la creación y la activación.
 */

import { type ContractDocumentType } from '@/databases/postgresql/entities/contratos/contract.entity';
import { GENERIC_TAX_COUNTRY, type TaxDocumentKind } from '@/databases/postgresql/entities/contratos/tax-document-type.entity';

import { normalizeCountry, suggestDocumentType } from './billing-engine';

/** Fila del catálogo tal como la expone la API (subconjunto de la tabla). */
export interface TaxDocumentTypeOption {
	id: string;
	country_code: string;
	code: string;
	name: string;
	kind: TaxDocumentKind;
	is_electronic: boolean;
	sort: number;
}

/** Solo los documentos que un contrato puede emitir (sin notas de crédito/débito ni boletas). */
export const CONTRACT_TAX_DOCUMENT_KINDS: readonly TaxDocumentKind[] = ['invoice', 'export_invoice'];

export const TAX_DOCUMENT_COUNTRY_MISMATCH_MESSAGE = 'El documento tributario no corresponde al país de la compañía emisora';

/** Etiqueta en español de la familia `document_type` (cuando el contrato no tiene documento del catálogo). */
export const DOCUMENT_TYPE_LABELS: Record<ContractDocumentType, string> = {
	FACTURA: 'Factura',
	FACTURA_EXPORTACION: 'Factura de exportación',
};

export const documentTypeLabel = (documentType: string | null | undefined): string | null =>
	documentType && documentType in DOCUMENT_TYPE_LABELS ? DOCUMENT_TYPE_LABELS[documentType as ContractDocumentType] : null;

/** Familia derivada del documento: `export_invoice` → FACTURA_EXPORTACION; cualquier otra → FACTURA. */
export const documentTypeFromKind = (kind: TaxDocumentKind | string | null | undefined): ContractDocumentType =>
	kind === 'export_invoice' ? 'FACTURA_EXPORTACION' : 'FACTURA';

const bySort = (a: TaxDocumentTypeOption, b: TaxDocumentTypeOption) => a.sort - b.sort || a.code.localeCompare(b.code);

/**
 * Documentos que puede emitir una compañía: las filas de su país (ISO-2, normalizado desde el texto libre de
 * `companies.country`); si el país no tiene ninguna, las genéricas (`*`). Sin país conocido → las genéricas.
 */
export function catalogForCountry(rows: TaxDocumentTypeOption[], companyCountry: string | null | undefined): TaxDocumentTypeOption[] {
	const country = normalizeCountry(companyCountry);
	const emittable = rows.filter((row) => CONTRACT_TAX_DOCUMENT_KINDS.includes(row.kind));
	const own = country ? emittable.filter((row) => row.country_code === country) : [];

	return (own.length ? own : emittable.filter((row) => row.country_code === GENERIC_TAX_COUNTRY)).sort(bySort);
}

/**
 * Documento sugerido (S1-7 sobre el catálogo): exportación cuando el país de la compañía y el de la razón social
 * difieren, factura local si no. Toma la primera fila de esa familia por `sort`; si la familia no existe en el país,
 * cae a la otra; `null` con catálogo vacío.
 */
export function suggestTaxDocumentType(
	catalog: TaxDocumentTypeOption[],
	companyCountry: string | null | undefined,
	entityCountry: string | null | undefined
): TaxDocumentTypeOption | null {
	const wanted: TaxDocumentKind = suggestDocumentType(companyCountry, entityCountry) === 'FACTURA_EXPORTACION' ? 'export_invoice' : 'invoice';
	const sorted = [...catalog].sort(bySort);

	return sorted.find((row) => row.kind === wanted) ?? sorted.find((row) => CONTRACT_TAX_DOCUMENT_KINDS.includes(row.kind)) ?? null;
}

/** Límite de descripción de un documento del catálogo (`description_max_chars`, spec facturas §3.6), tal como lo trae `DESCRIPTION_LIMITS_SQL`. */
export interface DescriptionLimitRow {
	country_code: string;
	kind: string;
	description_max_chars: number | string | null;
	sort?: number | string | null;
}

/**
 * Subconsulta con los documentos del catálogo que tienen límite de descripción (hoy solo Chile, 80): la usan el detalle de factura y el
 * constructor de descripción para resolver el límite de un contrato sin documento del catálogo (`resolveDescriptionMaxChars`).
 */
export const DESCRIPTION_LIMITS_SQL = `(SELECT COALESCE(jsonb_agg(jsonb_build_object('country_code', t.country_code, 'kind', t.kind,
		'description_max_chars', t.description_max_chars, 'sort', t.sort)), '[]'::jsonb)
	FROM tax_document_types t WHERE t.active AND t.description_max_chars IS NOT NULL)`;

/**
 * Límite de caracteres de la descripción de una línea para un contrato (null = sin límite): el de su documento del catálogo
 * (`contracts.tax_document_type_id`); si el contrato es anterior al catálogo, el del primer documento de la familia (`document_type`)
 * en el país de la compañía emisora.
 */
export function resolveDescriptionMaxChars(input: {
	tax_document_type_id: string | null;
	own_max_chars: number | string | null;
	company_country: string | null;
	document_type: string | null;
	limits: DescriptionLimitRow[] | null | undefined;
}): number | null {
	const valid = (value: unknown) => {
		const number = Number(value);

		return value !== null && value !== undefined && Number.isInteger(number) && number > 0 ? number : null;
	};

	if (input.tax_document_type_id) return valid(input.own_max_chars);
	const country = normalizeCountry(input.company_country);

	if (!country) return null;
	const kind: TaxDocumentKind = input.document_type === 'FACTURA_EXPORTACION' ? 'export_invoice' : 'invoice';
	const row = (input.limits ?? [])
		.filter((entry) => entry.country_code === country && entry.kind === kind)
		.sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))[0];

	return row ? valid(row.description_max_chars) : null;
}

/**
 * Límite de descripción de un contrato a partir de una fila que trae `tax_document_type_id`, `own_description_max_chars`
 * (`tdt.description_max_chars`), `company_country`, `document_type` y `description_limits` (`DESCRIPTION_LIMITS_SQL`, jsonb o texto).
 * La usan los caminos que GENERAN descripciones (activación, cambios, consumos) para ajustarlas al límite en el origen.
 */
export function descriptionMaxCharsOfRow(row: Record<string, unknown>): number | null {
	const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
	let limits = row.description_limits;

	if (typeof limits === 'string') {
		try {
			limits = JSON.parse(limits);
		} catch {
			limits = null;
		}
	}

	return resolveDescriptionMaxChars({
		tax_document_type_id: text(row.tax_document_type_id),
		own_max_chars: (row.own_description_max_chars ?? null) as number | string | null,
		company_country: text(row.company_country),
		document_type: text(row.document_type),
		limits: Array.isArray(limits) ? (limits as DescriptionLimitRow[]) : null,
	});
}
