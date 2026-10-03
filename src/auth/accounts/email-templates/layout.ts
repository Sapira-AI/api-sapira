import { escapeHtml } from '@/core/utils/escape-html';

/**
 * Layout común de los correos de cuenta (invitación, recuperar contraseña), versionado en el repo. Pensado para clientes de correo:
 * tablas, estilos en línea, ancho máximo 600 px, sin CSS externo ni SVG, logo PNG con texto alternativo y preheader oculto.
 * Colores de la marca (`front-sapira/styles/site-tokens.css`): violeta `#4917C6`, tinta `#0B0620`, lila de fondo `#FBF3FF`.
 * **Todo texto variable entra escapado aquí** (`escapeHtml`); las plantillas solo pasan texto plano.
 */
export const EMAIL_TEMPLATE_VERSION = 'v2-2026-10-03';

export const BRAND = {
	violet: '#4917C6',
	ink: '#0B0620',
	muted: '#5B5670',
	wash: '#FBF3FF',
	border: '#E9E3F5',
	white: '#FFFFFF',
} as const;

/** Logo PNG (264×66, se muestra a 132×33). Se puede cambiar con `EMAIL_LOGO_URL`. */
export const DEFAULT_LOGO_URL = 'https://aisapira.com/assets/branding/email-logo-dark.png';

export interface EmailLayout {
	/** `<title>` y vista previa en la bandeja (preheader). */
	title: string;
	preheader: string;
	heading: string;
	/** Párrafos en texto plano (se escapan). */
	paragraphs: string[];
	button: { label: string; url: string };
	/** Notas pequeñas bajo el botón (texto plano). */
	notes: string[];
	logoUrl?: string;
}

export interface RenderedEmail {
	subject: string;
	html: string;
	text: string;
}

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

export function renderLayout(layout: EmailLayout): string {
	const e = escapeHtml;
	const logo = layout.logoUrl || DEFAULT_LOGO_URL;
	const paragraphs = layout.paragraphs
		.map(
			(text) =>
				`<tr><td style="padding:0 0 16px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${BRAND.ink};">${e(text)}</td></tr>`
		)
		.join('\n');
	const notes = layout.notes
		.map(
			(text) =>
				`<tr><td style="padding:0 0 8px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${BRAND.muted};">${e(text)}</td></tr>`
		)
		.join('\n');

	return `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<title>${e(layout.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.wash};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${BRAND.wash};">${e(layout.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.wash};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td style="padding:0 0 24px 0;">
<img src="${e(logo)}" width="132" height="33" alt="Sapira" style="display:block;border:0;outline:none;text-decoration:none;height:33px;width:132px;font-family:${FONT};font-size:20px;font-weight:700;color:${BRAND.violet};">
</td></tr>
<tr><td style="background-color:${BRAND.white};border:1px solid ${BRAND.border};border-radius:12px;padding:40px 40px 32px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:0 0 20px 0;font-family:${FONT};font-size:22px;line-height:30px;font-weight:700;color:${BRAND.ink};">${e(layout.heading)}</td></tr>
${paragraphs}
<tr><td style="padding:8px 0 24px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" bgcolor="${BRAND.violet}" style="border-radius:8px;background-color:${BRAND.violet};">
<a href="${e(layout.button.url)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:${BRAND.white};text-decoration:none;border-radius:8px;">${e(layout.button.label)}</a>
</td></tr></table>
</td></tr>
${notes}
<tr><td style="padding:16px 0 0 0;border-top:1px solid ${BRAND.border};font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};">Si el botón no funciona, copia este enlace en tu navegador:<br><a href="${e(layout.button.url)}" style="color:${BRAND.violet};word-break:break-all;">${e(layout.button.url)}</a></td></tr>
</table>
</td></tr>
<tr><td align="center" style="padding:24px 0 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};">Sapira · <a href="https://aisapira.com" style="color:${BRAND.muted};text-decoration:underline;">aisapira.com</a></td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Versión texto plano con la misma estructura. */
export function renderLayoutText(layout: EmailLayout): string {
	return [
		layout.heading,
		'',
		...layout.paragraphs.flatMap((p) => [p, '']),
		`${layout.button.label}: ${layout.button.url}`,
		'',
		...layout.notes,
		'',
		'Sapira · aisapira.com',
	].join('\n');
}

/** Asunto en una línea (sin saltos que permitan inyectar headers). */
export const oneLine = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();
