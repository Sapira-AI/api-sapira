/**
 * Espejo del módulo `base-tenancy`: 8 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * Promovidas a `.entity.ts` (las carga el glob de database.module.ts): 8. Apagadas (`*.espejo.ts`, fuera del glob): 0.
 * Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { ClaudeSkill } from './claude-skill.entity';
export { CustomFieldDefinition } from './custom-field-definition.entity';
export { FinancialSettings } from './financial-settings.entity';
export { HoldingSettings } from './holding-settings.entity';
export { Permission } from './permission.entity';
export { Role } from './role.entity';
export { RolePermission } from './role-permission.entity';
export { UserViewPreference } from './user-view-preference.entity';
