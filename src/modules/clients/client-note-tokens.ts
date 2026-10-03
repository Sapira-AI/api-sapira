/**
 * Tokens de las notas de la Actividad del Cliente 360 (Notificaciones v2 fase 2, contrato §8.7). El texto guarda tokens estables:
 * - mención: `@[user:<uuid>]`
 * - referencia a un elemento del mismo cliente: `#[<tipo>:<uuid>]`, con tipo `contract`, `invoice`, `credit_note`, `quote`,
 *   `client_entity` (razón social) o `document`.
 * La API deriva de ellos `mentioned_user_ids` y `references`, y los vuelve texto legible (`@Nombre`, `#Etiqueta`) para la interfaz y la alerta.
 * Puro: sin Nest ni base.
 */
export const NOTE_REFERENCE_TYPES = ['contract', 'invoice', 'credit_note', 'quote', 'client_entity', 'document'] as const;
export type NoteReferenceType = (typeof NOTE_REFERENCE_TYPES)[number];
export interface NoteReference {
	type: NoteReferenceType;
	id: string;
}

export const MAX_NOTE_MENTIONS = 20;
export const MAX_NOTE_REFERENCES = 20;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const MENTION_RE = new RegExp(`@\\[user:(${UUID})\\]`, 'g');
const REFERENCE_RE = new RegExp(`#\\[(${NOTE_REFERENCE_TYPES.join('|')}):(${UUID})\\]`, 'g');
/** Cualquier token con forma `@[…]` o `#[…]` (también los mal formados, para no dejarlos crudos en la interfaz). */
const ANY_TOKEN_RE = /[@#]\[[a-z_]+:[^\]]*\]/g;

/** Menciones y referencias del texto, sin repetidos y en orden de aparición. */
export function parseNoteTokens(body: string): { mentioned_user_ids: string[]; references: NoteReference[] } {
	const mentions = [...new Set([...String(body ?? '').matchAll(MENTION_RE)].map((match) => match[1].toLowerCase()))];
	const seen = new Set<string>();
	const references: NoteReference[] = [];

	for (const match of String(body ?? '').matchAll(REFERENCE_RE)) {
		const reference = { type: match[1] as NoteReferenceType, id: match[2].toLowerCase() };
		const key = `${reference.type}:${reference.id}`;

		if (!seen.has(key)) {
			seen.add(key);
			references.push(reference);
		}
	}

	return { mentioned_user_ids: mentions, references };
}

/**
 * Texto legible: `@[user:id]` → `@Nombre` y `#[tipo:id]` → `#Etiqueta` (con los nombres y etiquetas resueltos). Lo que no se pudo resolver
 * queda como `@usuario` / `#elemento ya no disponible`; un token mal formado se quita.
 */
export function renderNoteText(body: string, names: Map<string, string>, labels: Map<string, string>): string {
	return String(body ?? '')
		.replace(MENTION_RE, (_, id: string) => `@${names.get(id.toLowerCase()) ?? 'usuario'}`)
		.replace(REFERENCE_RE, (_, type: string, id: string) => `#${labels.get(`${type}:${id.toLowerCase()}`) ?? 'elemento ya no disponible'}`)
		.replace(ANY_TOKEN_RE, '')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}

/** Fragmento para la alerta `user_mention` (una línea, ≤ `max` caracteres). */
export function noteExcerpt(text: string, max = 280): string {
	const line = text.replace(/\s+/g, ' ').trim();

	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
