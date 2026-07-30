/**
 * Utilidades de transformación de datos de Salesforce a Sapira
 */

/**
 * Transform Salesforce billing method to Sapira billing method
 * Prepago -> Anticipado, Postpago -> Vencido, default -> Anticipado
 */
export function transformBillingMethod(formaDepago?: string): 'Anticipado' | 'Vencido' {
	if (!formaDepago) return 'Anticipado';
	if (formaDepago === 'Prepago') return 'Anticipado';
	if (formaDepago === 'Postpago') return 'Vencido';
	return 'Anticipado';
}

/**
 * Determine if line item is recurring based on Recurrencia__c field
 * If starts with "Recurrente" -> true, if "One-Shot" -> false
 */
export function isRecurring(recurrencia?: string): boolean {
	if (!recurrencia) return false;
	return recurrencia.toLowerCase().startsWith('recurrente');
}

/**
 * Calculate discount percentage from ListPrice and UnitPrice
 * Since Discount field doesn't exist, we derive it from prices
 */
export function calculateDiscountPercentage(listPrice?: number, unitPrice?: number): number | null {
	if (!listPrice || !unitPrice || listPrice === 0) return null;
	if (unitPrice >= listPrice) return null; // No discount
	const discountPercentage = ((listPrice - unitPrice) / listPrice) * 100;
	return Math.round(discountPercentage * 100) / 100; // Round to 2 decimals
}

/**
 * Determine discount type based on whether there's a discount
 */
export function getDiscountType(listPrice?: number, unitPrice?: number): 'Porcentaje' | undefined {
	const discount = calculateDiscountPercentage(listPrice, unitPrice);
	if (discount != null && discount > 0) return 'Porcentaje';
	return undefined;
}

/**
 * Format date from ISO format to dd-mm-yyyy
 */
export function formatDateToDDMMYYYY(isoDate?: string): string | null {
	if (!isoDate) return null;
	try {
		const date = new Date(isoDate);
		const day = String(date.getDate()).padStart(2, '0');
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const year = date.getFullYear();
		return `${day}-${month}-${year}`;
	} catch {
		return null;
	}
}

/**
 * Convert ISO 3166-1 alpha-2 country code to full country name
 */
const COUNTRY_CODES: Record<string, string> = {
	AF: 'Afganistán',
	AL: 'Albania',
	DE: 'Alemania',
	AD: 'Andorra',
	AO: 'Angola',
	AI: 'Anguila',
	AQ: 'Antártida',
	AG: 'Antigua y Barbuda',
	SA: 'Arabia Saudita',
	DZ: 'Argelia',
	AR: 'Argentina',
	AM: 'Armenia',
	AW: 'Aruba',
	AU: 'Australia',
	AT: 'Austria',
	AZ: 'Azerbaiyán',
	BS: 'Bahamas',
	BD: 'Bangladés',
	BB: 'Barbados',
	BH: 'Baréin',
	BE: 'Bélgica',
	BZ: 'Belice',
	BJ: 'Benín',
	BM: 'Bermudas',
	BY: 'Bielorrusia',
	BO: 'Bolivia',
	BA: 'Bosnia y Herzegovina',
	BW: 'Botsuana',
	BR: 'Brasil',
	BN: 'Brunéi',
	BG: 'Bulgaria',
	BF: 'Burkina Faso',
	BI: 'Burundi',
	BT: 'Bután',
	CV: 'Cabo Verde',
	KH: 'Camboya',
	CM: 'Camerún',
	CA: 'Canadá',
	QA: 'Catar',
	TD: 'Chad',
	CL: 'Chile',
	CN: 'China',
	CY: 'Chipre',
	VA: 'Ciudad del Vaticano',
	CO: 'Colombia',
	KM: 'Comoras',
	KP: 'Corea del Norte',
	KR: 'Corea del Sur',
	CI: 'Costa de Marfil',
	CR: 'Costa Rica',
	HR: 'Croacia',
	CU: 'Cuba',
	CW: 'Curazao',
	DK: 'Dinamarca',
	DM: 'Dominica',
	EC: 'Ecuador',
	EG: 'Egipto',
	SV: 'El Salvador',
	AE: 'Emiratos Árabes Unidos',
	ER: 'Eritrea',
	SK: 'Eslovaquia',
	SI: 'Eslovenia',
	ES: 'España',
	US: 'Estados Unidos',
	EE: 'Estonia',
	ET: 'Etiopía',
	PH: 'Filipinas',
	FI: 'Finlandia',
	FJ: 'Fiyi',
	FR: 'Francia',
	GA: 'Gabón',
	GM: 'Gambia',
	GE: 'Georgia',
	GH: 'Ghana',
	GI: 'Gibraltar',
	GD: 'Granada',
	GR: 'Grecia',
	GL: 'Groenlandia',
	GP: 'Guadalupe',
	GU: 'Guam',
	GT: 'Guatemala',
	GF: 'Guayana Francesa',
	GG: 'Guernsey',
	GN: 'Guinea',
	GQ: 'Guinea Ecuatorial',
	GW: 'Guinea-Bisáu',
	GY: 'Guyana',
	HT: 'Haití',
	HN: 'Honduras',
	HK: 'Hong Kong',
	HU: 'Hungría',
	IN: 'India',
	ID: 'Indonesia',
	IQ: 'Irak',
	IR: 'Irán',
	IE: 'Irlanda',
	BV: 'Isla Bouvet',
	IM: 'Isla de Man',
	CX: 'Isla de Navidad',
	IS: 'Islandia',
	NF: 'Isla Norfolk',
	AX: 'Islas Åland',
	KY: 'Islas Caimán',
	CC: 'Islas Cocos',
	CK: 'Islas Cook',
	FO: 'Islas Feroe',
	GS: 'Islas Georgias del Sur y Sandwich del Sur',
	HM: 'Islas Heard y McDonald',
	FK: 'Islas Malvinas',
	MP: 'Islas Marianas del Norte',
	MH: 'Islas Marshall',
	UM: 'Islas Ultramarinas Menores de Estados Unidos',
	PN: 'Islas Pitcairn',
	SB: 'Islas Salomón',
	TC: 'Islas Turcas y Caicos',
	VG: 'Islas Vírgenes Británicas',
	VI: 'Islas Vírgenes de los Estados Unidos',
	IL: 'Israel',
	IT: 'Italia',
	JM: 'Jamaica',
	JP: 'Japón',
	JE: 'Jersey',
	JO: 'Jordania',
	KZ: 'Kazajistán',
	KE: 'Kenia',
	KG: 'Kirguistán',
	KI: 'Kiribati',
	KW: 'Kuwait',
	LA: 'Laos',
	LS: 'Lesoto',
	LV: 'Letonia',
	LB: 'Líbano',
	LR: 'Liberia',
	LY: 'Libia',
	LI: 'Liechtenstein',
	LT: 'Lituania',
	LU: 'Luxemburgo',
	MO: 'Macao',
	MK: 'Macedonia del Norte',
	MG: 'Madagascar',
	MY: 'Malasia',
	MW: 'Malaui',
	MV: 'Maldivas',
	ML: 'Malí',
	MT: 'Malta',
	MA: 'Marruecos',
	MQ: 'Martinica',
	MU: 'Mauricio',
	MR: 'Mauritania',
	YT: 'Mayotte',
	MX: 'México',
	FM: 'Micronesia',
	MD: 'Moldavia',
	MC: 'Mónaco',
	MN: 'Mongolia',
	ME: 'Montenegro',
	MS: 'Montserrat',
	MZ: 'Mozambique',
	MM: 'Myanmar',
	NA: 'Namibia',
	NR: 'Nauru',
	NP: 'Nepal',
	NI: 'Nicaragua',
	NE: 'Níger',
	NG: 'Nigeria',
	NU: 'Niue',
	NO: 'Noruega',
	NC: 'Nueva Caledonia',
	NZ: 'Nueva Zelanda',
	OM: 'Omán',
	NL: 'Países Bajos',
	PK: 'Pakistán',
	PW: 'Palaos',
	PS: 'Palestina',
	PA: 'Panamá',
	PG: 'Papúa Nueva Guinea',
	PY: 'Paraguay',
	PE: 'Perú',
	PF: 'Polinesia Francesa',
	PL: 'Polonia',
	PT: 'Portugal',
	PR: 'Puerto Rico',
	GB: 'Reino Unido',
	CF: 'República Centroafricana',
	CZ: 'República Checa',
	CD: 'República Democrática del Congo',
	DO: 'República Dominicana',
	CG: 'República del Congo',
	RE: 'Reunión',
	RW: 'Ruanda',
	RO: 'Rumania',
	RU: 'Rusia',
	EH: 'Sahara Occidental',
	WS: 'Samoa',
	AS: 'Samoa Americana',
	BL: 'San Bartolomé',
	KN: 'San Cristóbal y Nieves',
	SM: 'San Marino',
	MF: 'San Martín',
	PM: 'San Pedro y Miquelón',
	VC: 'San Vicente y las Granadinas',
	SH: 'Santa Elena, Ascensión y Tristán de Acuña',
	LC: 'Santa Lucía',
	ST: 'Santo Tomé y Príncipe',
	SN: 'Senegal',
	RS: 'Serbia',
	SC: 'Seychelles',
	SL: 'Sierra Leona',
	SG: 'Singapur',
	SX: 'Sint Maarten',
	SY: 'Siria',
	SO: 'Somalia',
	LK: 'Sri Lanka',
	SZ: 'Suazilandia',
	ZA: 'Sudáfrica',
	SD: 'Sudán',
	SS: 'Sudán del Sur',
	SE: 'Suecia',
	CH: 'Suiza',
	SR: 'Surinam',
	SJ: 'Svalbard y Jan Mayen',
	TH: 'Tailandia',
	TW: 'Taiwán',
	TZ: 'Tanzania',
	TJ: 'Tayikistán',
	IO: 'Territorio Británico del Océano Índico',
	TF: 'Territorios Australes Franceses',
	TL: 'Timor Oriental',
	TG: 'Togo',
	TK: 'Tokelau',
	TO: 'Tonga',
	TT: 'Trinidad y Tobago',
	TN: 'Túnez',
	TM: 'Turkmenistán',
	TR: 'Turquía',
	TV: 'Tuvalu',
	UA: 'Ucrania',
	UG: 'Uganda',
	UY: 'Uruguay',
	UZ: 'Uzbekistán',
	VU: 'Vanuatu',
	VE: 'Venezuela',
	VN: 'Vietnam',
	WF: 'Wallis y Futuna',
	YE: 'Yemen',
	DJ: 'Yibuti',
	ZM: 'Zambia',
	ZW: 'Zimbabue',
};

export function isoToCountryName(isoCode: string | null | undefined): string | null {
	if (!isoCode) return null;
	const upperCode = isoCode.toUpperCase();
	return COUNTRY_CODES[upperCode] || isoCode; // fallback al código si no se encuentra
}

/**
 * Normaliza identificadores fiscales sin alterar separadores significativos.
 * Se eliminan espacios Unicode y puntos; se preservan guiones, barras y letras.
 * El placeholder "pendiente", sin importar sus mayúsculas, se trata como ausencia de identificador.
 */
export function normalizeTaxId(taxId: string | null | undefined): string | null {
	if (taxId === null || taxId === undefined) {
		return null;
	}

	const normalized = String(taxId).replace(/[\s.]+/gu, '');
	if (!normalized || normalized.toLocaleLowerCase('es-CL') === 'pendiente') {
		return null;
	}

	return normalized;
}

/**
 * Build custom_fields JSON object for quote_items
 * Maps Salesforce pricing model levels 3-5 and other custom fields
 */
export function buildCustomFields(lineItem: any, priceListType?: string | null): Record<string, any> | null {
	const customFields: Record<string, any> = {};

	// Nivel 3: Fuente de dato / unidad
	if (lineItem.Fuente_de_unidad__c) {
		customFields.fuente_de_unidad = lineItem.Fuente_de_unidad__c;
	}

	// Nivel 4: Fuente de optimizaciones
	if (lineItem.Fuente_Optimizaciones__c) {
		customFields.fuente_optimizaciones = lineItem.Fuente_Optimizaciones__c;
	}

	// Tipo de lista de precios (desde Account.Lista_de_Precio__r.Tipo__c)
	if (priceListType) {
		customFields.price_list_type = priceListType;
	}

	return Object.keys(customFields).length > 0 ? customFields : null;
}

/**
 * Generar número de cliente desde Salesforce Account ID
 */
export function generateClientNumber(accountId: string, salesforceApiId?: string): string {
	return salesforceApiId || accountId;
}

/**
 * Limpiar y formatear dirección
 */
export function formatAddress(street?: string, city?: string, state?: string, postalCode?: string, country?: string): string | null {
	const parts = [street, city, state, postalCode, country].filter(Boolean);
	return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Transform Salesforce boolean-like fields to actual boolean
 * Handles: 'si', 'sí', 'yes', 'true', true
 */
export function transformToBoolean(value: any): boolean {
	if (value === null || value === undefined) return false;
	if (typeof value === 'boolean') return value;
	return ['si', 'sí', 'yes', 'true'].includes(String(value).toLowerCase().trim());
}

/**
 * Calculate term_months from start and end dates
 * If dates not available, returns 12 for recurring, 1 for one-shot
 */
export function calculateTermMonths(startDate?: string, endDate?: string, isRecurring?: boolean): number {
	if (startDate && endDate) {
		const start = new Date(startDate);
		const end = new Date(endDate);
		const diffTime = Math.abs(end.getTime() - start.getTime());
		const diffMonths = Math.ceil(diffTime / (1000 * 60 * 60 * 24 * 30));
		return diffMonths > 0 ? diffMonths : isRecurring ? 12 : 1;
	}
	return isRecurring ? 12 : 1;
}

/**
 * Parse Salesforce date string to Date object in local timezone
 * Evita problemas de timezone donde "2026-05-31" se muestra como "2026-05-30"
 * @param dateStr - Fecha en formato "YYYY-MM-DD" o "YYYY-MM-DDTHH:mm:ss.sssZ"
 * @returns Date object en zona horaria local, o null si no hay fecha
 */
export function parseSalesforceDate(dateStr: string | null | undefined): Date | null {
	if (!dateStr) return null;

	// Extraer solo la parte de fecha (YYYY-MM-DD)
	const datePart = dateStr.split('T')[0];
	const [year, month, day] = datePart.split('-').map(Number);

	// Crear Date en zona horaria local (no UTC)
	// month - 1 porque los meses en JS son 0-indexed
	return new Date(year, month - 1, day);
}
