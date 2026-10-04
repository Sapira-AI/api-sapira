import { AVATAR_PRESET_IDS, USER_AVATARS_BUCKET } from './me.constants';

/**
 * Avatar de una persona, igual en todos los endpoints (contrato `contrato-api-mi-perfil.md` §3): foto subida (`upload`, URL pública del
 * bucket `user-avatars`), avatar de la lista fija (`preset`) o iniciales (`initials`, el front las dibuja con el nombre).
 */
export type UserAvatar = { kind: 'initials' } | { kind: 'preset'; preset_id: string } | { kind: 'upload'; url: string };

/** Columnas de `users` que arman el avatar. Quien lista personas las trae en la misma consulta (sin N+1). */
export interface UserAvatarColumns {
	avatar_path?: unknown;
	avatar_preset?: unknown;
}

/** URL pública de una foto del bucket `user-avatars`. `supabaseUrl` por defecto: `SUPABASE_URL` del entorno. */
export function userAvatarUrl(path: string, supabaseUrl: string | undefined = process.env.SUPABASE_URL): string {
	const base = String(supabaseUrl ?? '').replace(/\/+$/, '');

	return `${base}/storage/v1/object/public/${USER_AVATARS_BUCKET}/${path}`;
}

/** Avatar a partir de `avatar_path` / `avatar_preset`. La foto manda; un preset que ya no está en la lista cae a iniciales. */
export function userAvatar(row: UserAvatarColumns | null | undefined, supabaseUrl?: string): UserAvatar {
	const path = row?.avatar_path;
	const preset = row?.avatar_preset;

	if (typeof path === 'string' && path) return { kind: 'upload', url: userAvatarUrl(path, supabaseUrl) };
	if (typeof preset === 'string' && AVATAR_PRESET_IDS.includes(preset)) return { kind: 'preset', preset_id: preset };

	return { kind: 'initials' };
}
