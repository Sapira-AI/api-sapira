import { normalizeTaxId } from '@/modules/salesforce/utils/salesforce-transformers';

/** Guiones tipográficos que llegan por copiar y pegar (`–`, `—`, `‐`, `−`…): se tratan como `-` (caso SENAPRED 11-08). */
const TYPOGRAPHIC_DASHES = /[‐-―−﹘﹣－]/g;

/**
 * Identificador tributario canónico para buscar el partner en Odoo: sin espacios ni puntos (como `normalizeTaxId`),
 * guiones tipográficos → `-` y en mayúsculas (`k` del RUT, RFC). `null` si queda vacío o es "pendiente".
 */
export function canonicalVat(value: unknown): string | null {
	if (value === null || value === undefined || value === false) return null;
	const normalized = normalizeTaxId(String(value).replace(TYPOGRAPHIC_DASHES, '-'));

	return normalized ? normalized.toUpperCase() : null;
}

/** Clave de comparación: solo letras y dígitos en mayúsculas (`76.397.190-2`, `76397190-2` y `763971902` son la misma). */
export function vatKey(value: unknown): string {
	if (value === null || value === undefined || value === false) return '';

	return String(value)
		.replace(/[^0-9a-z]/gi, '')
		.toUpperCase();
}

const CHILEAN_RUT_KEY = /^(\d{7,8})([0-9K])$/;

/** `76397190` → `76.397.190`. */
const withThousands = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/**
 * Formas en que el mismo identificador puede estar guardado en `res.partner.vat` (Odoo compara `vat` carácter a carácter):
 * tal cual, canónico, sin separadores y, si parece RUT chileno, con guion y con puntos (`76397190-2` / `76.397.190-2`, `k` y `K`).
 */
export function vatSearchVariants(taxId: unknown): string[] {
	const raw = taxId === null || taxId === undefined ? '' : String(taxId).trim();
	const canonical = canonicalVat(raw);
	const key = vatKey(raw);
	const variants = new Set<string>([raw, canonical ?? '', key]);
	const rut = CHILEAN_RUT_KEY.exec(key);

	if (rut) {
		const [, body, dv] = rut;

		for (const digit of dv === 'K' ? ['K', 'k'] : [dv]) {
			variants.add(`${body}-${digit}`);
			variants.add(`${withThousands(body)}-${digit}`);
		}
	}
	if (canonical) variants.add(canonical.toLowerCase());

	return [...variants].filter(Boolean);
}

/**
 * ¿El `vat` que devolvió Odoo corresponde al identificador buscado? Compara por `vatKey`. Si el parser XML-RPC devolvió el
 * vat como NÚMERO (`parseTagValue: true` en `xml-rpc-client.helper.ts`), los ceros iniciales se perdieron
 * (`06142406041060` → `6142406041060`, NIT de El Salvador, caso Ransa SV 15-09): se compara también sin ceros iniciales.
 */
export function vatMatches(partnerVat: unknown, taxId: unknown): boolean {
	const expected = vatKey(taxId);

	if (!expected || partnerVat === null || partnerVat === undefined || partnerVat === false || partnerVat === '') return false;
	if (typeof partnerVat === 'number') return String(partnerVat) === expected.replace(/^0+/, '');

	return vatKey(partnerVat) === expected;
}

/** Id de un many2one de Odoo (`[id, nombre]` o `false`). */
export const many2oneId = (value: unknown): number | null => (Array.isArray(value) && typeof value[0] === 'number' ? value[0] : null);

/** Nombre de un many2one de Odoo (`[id, nombre]` o `false`). */
export const many2oneName = (value: unknown): string | null => (Array.isArray(value) && typeof value[1] === 'string' ? value[1] : null);

/**
 * En Odoo los contactos hijos de una empresa heredan su `vat`: buscar por vat devuelve la empresa y sus contactos, y eso
 * hacía "ambiguo" un RUT que tiene un solo partner comercial. Se descartan los hijos cuyo padre también está en el resultado.
 */
export function withoutChildContacts<T extends { id: number; parent_id?: unknown }>(partners: T[]): T[] {
	const ids = new Set(partners.map((partner) => partner.id));

	return partners.filter((partner) => {
		const parentId = many2oneId(partner.parent_id);

		return parentId === null || !ids.has(parentId);
	});
}
