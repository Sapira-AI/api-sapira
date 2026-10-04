# Archivo de edge functions retiradas

Fuentes de edge functions de Supabase que se retiraron de producción (`hklompkypzqtglprfobu`). Los archivos llevan `.txt` al final
para que ni TypeScript ni ESLint los tomen. No se reactivan tal cual: si una capacidad vuelve, se construye en la API.

| Función | Retiro | Cómo | Fuente |
|---|---|---|---|
| `agents-webhook` | 03-10-2026 | Reemplazada por un stub que responde 410 (v12) | [`agents-webhook.v11.ts.txt`](agents-webhook.v11.ts.txt), bajada del deploy (no tenía fuente en ningún repo) |
| `send-invitation`, `delete-user` | 04-10-2026, switch | Borradas (`supabase functions delete`) | `sapira-ai` `23ff49e` |
| `sync-exchange-rates` | 04-10-2026, switch | Borrada | `sapira-ai` `dd5a84d` |
| `diagnose-odoo-model`, `diagnose-odoo-invoices`, `get-odoo-companies` (+ `_shared`) | 04-10-2026, switch | Borradas | `sapira-ai` `abb5967` |
| `chargebee-proxy` | 04-10-2026, switch | Borrada | `sapira-ai` `985d208` |
| `data-gateway`, `rag-ingest` | 04-10-2026, switch | Borradas | `sapira-ai` `4566d83` |
| `rag-chat` | 04-10-2026, switch | Borrada | `sapira-ai` `f069c50` |
| `rag-ingest-semantic-catalog` | 04-10-2026, switch | Borrada | `sapira-ai` `0eb4cfa` |

Las del switch se copiaron desde `sapira-ai/supabase/functions/` (HEAD `ed74d75`), el repo desde el que se publicaban; el
`supabase functions download` de la CLI 2.58 no pudo bajar los bundles. Motivo de cada retiro (sin llamadores fuera del front viejo,
0 invocaciones en 30 días, reemplazo en la API): [`../switch-supabase-inventario.md`](../switch-supabase-inventario.md) §2.

Siguen publicadas a propósito: `check-overdue-invoices` (cron diario, la API depende del estado `Vencida`), `send-proforma` y
`send-collection` (se ven con Automatizaciones), las de Odoo que usa Leon y las `agents-*`.
