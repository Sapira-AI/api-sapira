/** Id de un registro del CRM: 15 caracteres (distingue mayúsculas) o 18 (con sufijo de verificación). */
export const SALESFORCE_ID_PATTERN = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

const SUFFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

/**
 * Id del CRM en su forma de 18 caracteres, que es la que devuelve la API del CRM y la que guarda Sapira. Un id de 15 se completa
 * con el sufijo estándar (por cada bloque de 5 caracteres, un carácter que codifica cuáles son mayúsculas); uno de 18 queda igual.
 * `null` si no es un id válido.
 */
export function toSalesforceId18(value: string | null | undefined): string | null {
	const id = (value ?? '').trim();

	if (!SALESFORCE_ID_PATTERN.test(id)) return null;
	if (id.length === 18) return id;
	const suffix = [0, 5, 10]
		.map((start) => {
			const bits = [...id.slice(start, start + 5)].reduce((sum, char, index) => sum + (char >= 'A' && char <= 'Z' ? 1 << index : 0), 0);

			return SUFFIX_ALPHABET[bits];
		})
		.join('');

	return `${id}${suffix}`;
}
