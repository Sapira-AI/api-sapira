/**
 * Espejo del módulo `base-tenancy`: 8 tablas de `public` SIN entity previa en el repo, generadas desde prod en vivo.
 * APAGADAS en runtime (`*.espejo.ts`: el glob de entities de database.module.ts solo carga `*.entity.ts`). Las tablas que ya tenían entity no se duplican: ver README.md.
 */
export { ClaudeSkill } from './claude-skill.espejo';
export { CustomFieldDefinition } from './custom-field-definition.espejo';
export { FinancialSettings } from './financial-settings.espejo';
export { HoldingSettings } from './holding-settings.espejo';
export { Permission } from './permission.entity';
export { Role } from './role.espejo';
export { RolePermission } from './role-permission.espejo';
export { UserViewPreference } from './user-view-preference.espejo';
