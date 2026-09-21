/**
 * Espejo del módulo `suscripciones`: 2 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * Promovidas a `.entity.ts` (las carga el glob de database.module.ts): 2. Apagadas (`*.espejo.ts`, fuera del glob): 0.
 * Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { Subscription } from './subscription.entity';
export { SubscriptionItem } from './subscription-item.entity';
