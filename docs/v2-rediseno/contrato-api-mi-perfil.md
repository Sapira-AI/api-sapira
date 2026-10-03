# Contrato API · Mi perfil

> v1 · 03-10-2026 · rama `domi`, sin commit. Endpoints del usuario de la sesión para la página **Mi perfil** del front nuevo
> (`front-sapira`). Código: `src/modules/me/` (README). Migración **sin aplicar**: `1791050000000-UserProfileAvatarAndAccountEvents` (§6).

## 0. Reglas comunes

-   **Auth**: `Authorization: Bearer <token Supabase>` (`SupabaseAuthGuard`, global). Todo es sobre **el usuario de la sesión**: no hay
    `user_id`, `holding_id` ni `x-holding-id` (se ignora si llega). Una persona sin fila en `users` → 404 `Usuario no encontrado`.
-   **Errores**: `{ message }` en español; validación → 400 `{ message, errors: [{ field, message }] }`; campos desconocidos → 400
    (`forbidNonWhitelisted`); límites de frecuencia → 429.
-   La BFF del front reenvía el `Authorization` tal cual (lo necesitan `POST /me/sessions/revoke-all` y `POST /me/password`).

## 1. `GET /me/profile`

```jsonc
{
  "id": "uuid (users.id)",
  "name": "Domi Zamora",                 // users.name (editable)
  "email": "domi@aisapira.com",          // users.email, solo lectura
  "avatar": { "kind": "initials" }       // o { "kind": "preset", "preset_id": "preset-04" }
                                          // o { "kind": "upload", "url": "https://…/storage/v1/object/public/user-avatars/users/<id>/<uuid>.png" }
  "avatar_presets": ["preset-01", …, "preset-12"],   // catálogo fijo (§4); el front los dibuja
  "providers": ["password", "google"],   // con qué entra: password | google | azure (ver nota)
  "has_password": true,                  // false → no mostrar "Cambiar contraseña" (ofrecer "crear contraseña" por recuperar)
  "last_access_at": "2026-10-03T12:00:00.000Z" | null,  // users.last_access (lo mismo que muestra Configuración › Usuarios)
  "is_super_admin": false,
  "holdings": [                          // solo membresías activas, orden por nombre; solo lectura
    { "id": "uuid", "name": "Hanka", "logo_url": "…" | null, "role_name": "Administrador" | null, "selected": true }
  ]
}
```

-   `providers` sale de las `identities` de Supabase Auth (las del `getUser` de la sesión; si no vinieran, `auth.admin.getUserById`).
    `email` se informa como `password` **solo si la cuenta tiene contraseña**; una cuenta invitada que nunca creó contraseña tiene la
    identidad `email` pero no la muestra (entra con enlace o con Google/Microsoft). `azure` = Microsoft (el front dice "Microsoft").
-   `has_password`: `auth.users.encrypted_password` no vacío, leído como booleano (nunca se lee el hash). Si la consulta falla → se deduce
    de que haya identidad `email` con `last_sign_in_at`.
-   `role_name`: el rol de `users.role_id` **solo en el holding al que pertenece ese rol** (`roles.holding_id`); en los demás `null`
    (el front muestra "Sin rol"). Super admin: `role_name` = `"Super Admin"` en todos.

## 2. `PATCH /me/profile`

Body (todo opcional, al menos uno):

| Campo    | Regla                                                                       | Mensaje                                                                                    |
| -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `name`   | texto, recortado, 2–100 caracteres                                          | `El nombre debe tener al menos 2 caracteres` / `El nombre no puede superar 100 caracteres` |
| `avatar` | `{ "kind": "initials" }` o `{ "kind": "preset", "preset_id": "preset-NN" }` | `Elige un avatar de la lista` / `El avatar no es válido`                                   |

-   `avatar.kind = "upload"` **no** se acepta aquí (400 `La foto se sube con "Subir foto"`): la foto entra por §3.
-   Elegir `initials` o un preset borra la foto subida (columna y objeto en Storage).
-   `email` u otros campos → 400 (campo desconocido). Respuesta: el perfil completo (§1).

## 3. Foto subida (URL firmada)

### 3.1 `POST /me/avatar/upload-url`

Body `{ "file_name": "yo.png", "mime_type": "image/png" | "image/jpeg" | "image/webp", "size": 123456 }`.
Límites: PNG/JPG/WEBP, **≤ 2 MB** (`La foto debe ser PNG, JPG o WEBP`, `La foto no puede superar 2 MB`). Cuadrada recomendada (el front
recorta o centra; la API no mide dimensiones). 10 por minuto por persona.

```json
{
	"path": "users/<users.id>/<uuid>.png",
	"upload_url": "https://…/storage/v1/object/upload/sign/user-avatars/…?token=…",
	"token": "…",
	"max_bytes": 2097152
}
```

El navegador sube con `PUT upload_url` (o `supabase.storage.from('user-avatars').uploadToSignedUrl(path, token, file)`, que es solo
transporte con la URL firmada que emitió la API) y `Content-Type` = `mime_type`. El bucket rechaza por sí mismo otro tipo o > 2 MB.

### 3.2 `POST /me/avatar/confirm`

Body `{ "path": "users/<users.id>/<uuid>.png" }`. Valida que la ruta sea de esta persona (si no → 400 `La foto no es válida`), que el
objeto exista (si no → 409 `La foto no terminó de subirse: vuelve a intentarlo`) y que pese ≤ 2 MB (si no, se borra → 400). Guarda
`users.avatar_path`, limpia `avatar_preset` y borra la foto anterior. Respuesta: el perfil completo (§1) con `avatar.kind = "upload"`.

### 3.3 Bucket: `user-avatars`, **público**

-   Decisión: público, como `company-logos` (logos de holding/compañía, mismo flujo). Motivo: el avatar se muestra en muchos sitios
    (menú, listas de usuarios, menciones, actividad, correos) y una URL pública es cacheable y no caduca; con un bucket privado cada lista
    tendría que firmar N URLs con TTL.
-   Mitigaciones: ruta con UUID aleatorio (no enumerable; sin policy de listado en `storage.objects`), al cambiar o quitar la foto se borra
    el objeto (la URL vieja deja de servir), solo PNG/JPG/WEBP (sin SVG: un SVG público puede llevar scripts), 2 MB en el bucket.
-   Se guarda la **ruta** (`avatar_path`), no la URL: si mañana el bucket pasa a privado, solo cambia cómo se arma `avatar.url`.

## 4. Presets

`preset-01` … `preset-12` (constante `AVATAR_PRESET_IDS` en `src/modules/me/me.constants.ts`, también en `avatar_presets` de §1). La API
solo valida el id; el dibujo (color + figura) vive en el front. Agregar presets = sumar ids en la constante (sin migración).

## 5. Seguridad de la cuenta

### 5.1 `POST /me/sessions/revoke-all` — cerrar sesión en todos los dispositivos

Sin body. La API llama `auth.admin.signOut(<jwt de la sesión>, 'global')`: revoca **todos** los refresh tokens de la persona (incluida
la sesión actual). Respuesta `200 { "message": "Cerramos tu sesión en todos los dispositivos" }`. 5 por minuto por persona.

-   Los access tokens ya emitidos siguen siendo válidos hasta que vencen (JWT de Supabase, 1 h por defecto): es como funciona Supabase.
-   El front, al recibir 200, cierra la sesión local (`supabase.auth.signOut({ scope: 'local' })`, borra cookies) y va a `/login`.
-   Auditoría: `user_access_events` acción `sessions_revoked` (§6).

### 5.2 `POST /me/password` — cambiar contraseña (decisión: vía API)

Body `{ "current_password": "…", "new_password": "…", "sign_out_other_sessions": false }`.

| Regla                                                                                                                      | Respuesta                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| La cuenta no tiene contraseña (`has_password = false`)                                                                     | 409 `Tu cuenta no tiene contraseña: entra con Google o Microsoft, o crea una desde "¿Olvidaste tu contraseña?"` |
| `new_password` ≥ 8 y ≤ 72 caracteres, con al menos una letra y un número (mismas reglas que `/bienvenida`, `REGLAS_CLAVE`) | 400 `field: new_password`                                                                                       |
| `new_password` igual a la actual                                                                                           | 400 `La contraseña nueva debe ser distinta de la actual`                                                        |
| `current_password` incorrecta                                                                                              | 400 `field: current_password`, `La contraseña actual no es correcta`                                            |
| Supabase rechaza la nueva (política del proyecto, contraseña filtrada)                                                     | 400 `field: new_password` con el motivo en español                                                              |

-   200 `{ "message": "Contraseña actualizada" }`. 5 por minuto por persona (además del límite de Supabase al verificar).
-   `sign_out_other_sessions: true` → además `auth.admin.signOut(<jwt>, 'others')`: cierra las demás sesiones y mantiene esta.
-   Auditoría: `password_changed` (con `details.signed_out_others`).

**Por qué por la API y no `supabase.auth.updateUser({ password })` en el front:**

1. Exige la **contraseña actual** siempre: un token robado o una sesión abierta en otro equipo no basta para cambiarla. `updateUser`
   no la pide; con "Secure password change" activo, Supabase exige `reauthenticate()` (un código por correo, `nonce`) solo si el ingreso
   tiene más de 24 h — más pasos y peor UX que pedir la actual.
2. Mismas reglas en el servidor (no solo en el formulario) y auditoría en `user_access_events`.
3. La verificación se hace con `signInWithPassword` en un cliente desechable y esa sesión temporal se cierra en el acto
   (`admin.signOut(token, 'local')`); el cambio, con `auth.admin.updateUserById`. La contraseña no se guarda ni se registra.

`/bienvenida?modo=recuperar` (recuperar contraseña por enlace) **sigue** con `updateUser` en el front: ahí no hay contraseña actual y el
enlace de un solo uso ya prueba la identidad. Recomendación de configuración (Domi/QA): activar "Secure password change" en Supabase
Auth para que un `updateUser` directo con la anon key también pida reautenticación.

## 6. Base de datos (migración `1791050000000-UserProfileAvatarAndAccountEvents`, **NO APLICADA**)

-   `users.avatar_preset text NULL` (id de §4) y `users.avatar_path text NULL` (ruta en `user-avatars`), con
    `CHECK users_avatar_one_kind_check (avatar_preset IS NULL OR avatar_path IS NULL)`. No existía ninguna columna de avatar ni de
    nombre aparte (`users.name` es el nombre; `full_name` solo vive en la metadata de Auth y `sync_user_on_login` hace
    `name = COALESCE(name, …)`, así que no pisa el nombre editado).
-   `user_access_events.holding_id` pasa a **nullable** (eventos de la cuenta, no de un holding) y el CHECK de `action` suma
    `password_changed` y `sessions_revoked`.
-   Bucket `user-avatars` (público, 2 MB, PNG/JPG/WEBP), `ON CONFLICT DO NOTHING`.
-   Debe aplicarse **antes** de desplegar la API con `/me/*` (las lecturas usan las columnas nuevas). Orden: commit → QA
    (`schema:status` + `schema:log`) → prod con OK.

## 7. Estado y verificación (03-10)

-   Código, tests y build verdes: `src/modules/me/*.spec.ts` (servicio, HTTP con el `ValidationPipe` real, cableado de Nest, migración) y
    `src/auth/accounts/supabase-admin.service.spec.ts`. Sin commit; migración sin aplicar.
-   Observación (QA, solo lectura 03-10): en QA no existe el bucket `company-logos` (sí `company-files` y `client-files`); el de avatares
    lo crea la migración en cada entorno.
-   Límite de Supabase al verificar la contraseña: `signInWithPassword` sale desde la IP de la API, así que cuenta para el límite de
    ingresos por IP del proyecto (por defecto 30 cada 5 min). Un cambio de contraseña es raro; si se acerca, se ve como 429 `Demasiados intentos`.
