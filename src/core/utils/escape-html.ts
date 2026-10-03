/**
 * Escapa texto para interpolarlo en HTML (correos). Única implementación del repo para código nuevo: la usan Facturación
 * (`billing-states.ts`, que la reexporta) y la invitación de usuarios de Configuración. Nunca se interpola en HTML un valor sin pasar por aquí.
 */
export const escapeHtml = (value: string): string =>
	value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
