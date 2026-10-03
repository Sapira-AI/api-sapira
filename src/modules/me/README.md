# Módulo `me` (Mi perfil)

Endpoints del usuario de la sesión para la página **Mi perfil** del front nuevo. Contrato (shapes, reglas, mensajes y decisiones):
`docs/v2-rediseno/contrato-api-mi-perfil.md`. Solo sesión (`SupabaseAuthGuard`): sin holding, sin permisos, sin `user_id` en el body.

| Archivo            | Qué hace                                                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `me.controller.ts` | `GET/PATCH /me/profile`, `POST /me/avatar/upload-url`, `POST /me/avatar/confirm`, `POST /me/sessions/revoke-all`, `POST /me/password`; `callerOf` arma quién llama desde la sesión y el JWT                                                                                        |
| `me.service.ts`    | Perfil (`users` + membresías activas con rol del mismo holding + identidades de Auth), avatar (preset o foto en el bucket público `user-avatars`), cierre global de sesiones y cambio de contraseña verificando la actual; auditoría en `user_access_events` con `holding_id` NULL |
| `me.constants.ts`  | Presets (`preset-01…12`), bucket y límites de la foto, reglas de contraseña (las de `/bienvenida`), límites por persona                                                                                                                                                            |
| `user-avatar.ts`   | `userAvatar(row)`: el único armado del `avatar` (foto > preset > iniciales); lo usan `users/me/context`, menciones, Actividad del cliente, alertas y Configuración › Usuarios                                                                                                      |
| `dtos/me.dto.ts`   | Validación con mensajes en español (`forbidNonWhitelisted` global)                                                                                                                                                                                                                 |

Dependencias: `SupabaseAdminService` (`src/auth/accounts/`: `getUser`, `signOut`, `verifyPassword`, `updatePassword`) y
`SettingsStorageService` (reutilizado como provider: firmar subida, tamaño del objeto, borrar). Migración **sin aplicar**:
`1791050000000-UserProfileAvatarAndAccountEvents` (columnas `users.avatar_preset`/`avatar_path`, `user_access_events.holding_id` nullable
y acciones nuevas, bucket `user-avatars`); debe aplicarse antes de desplegar.
