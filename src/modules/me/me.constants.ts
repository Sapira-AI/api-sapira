import { actorTracker } from '@/auth/accounts/actor-throttle';

/** Avatares de la lista fija de Mi perfil (contrato §4). El front los dibuja; la API solo valida el id. Sumar uno = sumar el id aquí. */
export const AVATAR_PRESET_IDS = Array.from({ length: 12 }, (_, index) => `preset-${String(index + 1).padStart(2, '0')}`) as readonly string[];

/** Bucket **público** de fotos de perfil (migración 1791050000000: 2 MB; PNG, JPG, WEBP). Decisión en el contrato §3.3. */
export const USER_AVATARS_BUCKET = 'user-avatars';
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MIME_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Reglas de contraseña: las mismas de `/bienvenida` en el front (`REGLAS_CLAVE`): 8+ caracteres, una letra y un número. 72 = límite de bcrypt. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;
export const PASSWORD_LETTER = /[A-Za-zÀ-ÿ]/;
export const PASSWORD_DIGIT = /\d/;

/** Límites por persona (`actorTracker`: `sub` del JWT, el `ThrottlerGuard` global corre antes que la sesión). */
export const AVATAR_UPLOAD_THROTTLE = { short: { limit: 10, ttl: 60_000, getTracker: actorTracker } };
export const ACCOUNT_SECURITY_THROTTLE = { short: { limit: 5, ttl: 60_000, getTracker: actorTracker } };
