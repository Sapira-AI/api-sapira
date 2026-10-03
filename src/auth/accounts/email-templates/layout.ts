import { escapeHtml } from '@/core/utils/escape-html';

/**
 * Layout común de los correos de cuenta (invitación, recuperar contraseña), versionado en el repo.
 *
 * Pensado para clientes de correo: tablas, estilos en línea, 600 px, sin SVG ni hojas de estilo propias (el único `<link>` es la fuente
 * de Google Fonts y el único `<style>` es el respaldo Arial dentro del condicional de Outlook), imágenes PNG/JPG con `alt`, preheader oculto y `bgcolor` + VML para Outlook en el hero.
 * Dos variantes: **A** (default) hero con grilla sutil sobre degradado violeta profundo (piezas de marca) y **B** banda clara con degradado suave.
 * Modo oscuro: el texto nunca va sobre una imagen clara (Gmail invierte colores pero no imágenes); el hero A y el pie son oscuros
 * por diseño y el cuerpo es blanco con texto oscuro, que los clientes invierten de forma coherente.
 * Marca real del Sapira Design System (a3b828e2): colores exactos de `tokens/colors.css`, Plus Jakarta Sans por `<link>` de Google
 * Fonts (fuera de Outlook) con Helvetica/Arial de respaldo, logo vectorial oficial exportado a PNG @2x y un check Lucide (bloque del rol).
 * Assets estáticos en `front-sapira/public/assets/branding/email/` (servidos en `https://aisapira.com/assets/branding/email/`).
 * **Todo texto variable entra escapado aquí** (`escapeHtml`); las plantillas solo pasan texto plano.
 */
export const EMAIL_TEMPLATE_VERSION = 'v3-2026-10-03';

/** Colores exactos de los tokens del Sapira Design System (`tokens/colors.css`, a3b828e2); el nombre del token va al lado. */
export const BRAND = {
	violet: '#4917C6', // --violet-600 (primario)
	violet500: '#6E3AE2', // --violet-500
	violetDeep: '#2B0E86', // --gradient-hero-dark (paso 32%)
	violetSoft: '#F4ECFF', // --violet-50
	violetLine: '#E7D7FF', // --violet-100
	lilac: '#E9B0FF', // --lilac-300
	lilac200: '#F3D4FF', // --lilac-200
	ink: '#030418', // --ink-950 (texto fuerte)
	heroInk: '#140047', // base de las piezas de marca (historias de IG / carrusel): fondo del hero A y respaldo de Outlook
	pink: '#FFA7FF', // botón de las piezas de marca (texto #140047: contraste 10.9:1)
	body: '#383838', // --gray-800
	muted: '#5F5F65', // --gray-600
	page: '#F8F6FB', // --gray-50
	tint: '#FBF3FF', // --lilac-wash
	border: '#EBEBEB', // --gray-200
	white: '#FFFFFF', // --white
	onDarkBody: '#E7D7FF', // --violet-100 sobre tinta
	onDarkMuted: '#C7C7CE', // --gray-300 sobre tinta
} as const;

/** Carpeta pública de los assets del correo (hero, logos, íconos). */
export const DEFAULT_ASSET_BASE_URL = 'https://aisapira.com/assets/branding/email';

/**
 * Logo para fondo oscuro (isotipo de color + palabra en blanco, PNG 280×70, se muestra a 140×35): hero A y pie.
 * Sigue a `assetBaseUrl`; `EMAIL_LOGO_URL` lo reemplaza y debe ser una versión **clara** del logo.
 */
export const DEFAULT_LOGO_URL = `${DEFAULT_ASSET_BASE_URL}/logo-claro.png`;

export type EmailVariant = 'a' | 'b';

export interface EmailOptions {
	/** `a` (default): hero oscuro. `b`: hero claro con degradado suave. */
	variant?: EmailVariant;
	/** Base de los assets (sin `/` final). Default `DEFAULT_ASSET_BASE_URL`; en previews locales, `file:///…/email`. */
	assetBaseUrl?: string;
}

export interface EmailLayout {
	/** `<title>` y vista previa en la bandeja (preheader). */
	title: string;
	preheader: string;
	/** Etiqueta corta sobre el titular (p. ej. "Invitación"). */
	eyebrow: string;
	heading: string;
	/** Texto breve del hero. */
	lead: string;
	button: { label: string; url: string };
	/** Saludo y párrafos del cuerpo (texto plano). */
	paragraphs: string[];
	/** Bloque del rol asignado: título ("Tu rol: Finanzas"), bajada, capacidades (todas con el mismo check PNG) y una línea de cierre. */
	role?: { title: string; intro: string; items: { text: string }[]; footnote: string };
	/** Línea corta con acceso alternativo (Google/Microsoft) y enlace al inicio de sesión. */
	altLogin?: { text: string; label: string; url: string };
	/** Aviso destacado (p. ej. de seguridad). */
	callout?: string;
	/** Notas pequeñas (vencimiento, etc.). */
	notes: string[];
	logoUrl?: string;
}

export interface RenderedEmail {
	subject: string;
	html: string;
	text: string;
}

/** Tipografía de marca (Plus Jakarta Sans, Google Fonts) con respaldo seguro: muchos clientes no cargan webfonts. */
const FONT = `'Plus Jakarta Sans',Helvetica,Arial,sans-serif`;
export const BRAND_FONT_URL = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;700;800&display=swap';
const FOOTER_TAGLINE = 'Del cierre de una venta al ingreso a caja.';
export const LOGIN_LINK_LABEL = 'Ir al inicio de sesión';
const FOOTER_DISCLAIMER = 'Si no esperabas este correo, ignóralo.';
const e = escapeHtml;

const font = (size: number, lineHeight: number, color: string, extra = '') =>
	`font-family:${FONT};font-size:${size}px;line-height:${lineHeight}px;color:${color};${extra}`;

function button(label: string, url: string, onDark: boolean): string {
	const bg = onDark ? BRAND.pink : BRAND.violet;
	const fg = onDark ? BRAND.heroInk : BRAND.white;

	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" bgcolor="${bg}" style="border-radius:999px;background-color:${bg};">
<a href="${e(url)}" target="_blank" style="display:inline-block;padding:16px 32px;${font(16, 20, fg, 'font-weight:700;text-decoration:none;border-radius:999px;')}">${e(label)}&nbsp;&rarr;</a>
</td></tr></table>`;
}

function eyebrow(label: string, onDark: boolean): string {
	const bg = onDark ? BRAND.violetDeep : BRAND.violetSoft;
	const fg = onDark ? BRAND.lilac200 : BRAND.violet;
	const border = onDark ? BRAND.violet500 : BRAND.violetLine;

	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="${bg}" style="background-color:${bg};border:1px solid ${border};border-radius:999px;padding:5px 12px;${font(12, 16, fg, 'font-weight:700;letter-spacing:1px;text-transform:uppercase;')}">${e(label)}</td>
</tr></table>`;
}

/** Titular + texto + botón del hero (sobre fondo oscuro o blanco). */
function heroCopy(layout: EmailLayout, onDark: boolean): string {
	const headingColor = onDark ? BRAND.white : BRAND.ink;
	const leadColor = onDark ? BRAND.onDarkBody : BRAND.muted;

	return `<tr><td style="padding:0 0 18px 0;">${eyebrow(layout.eyebrow, onDark)}</td></tr>
<tr><td style="padding:0 0 14px 0;"><h1 style="margin:0;${font(34, 40, headingColor, 'font-weight:800;letter-spacing:-0.5px;')}">${e(layout.heading)}</h1></td></tr>
<tr><td style="padding:0 0 28px 0;${font(17, 26, leadColor)}">${e(layout.lead)}</td></tr>
<tr><td style="padding:0;">${button(layout.button.label, layout.button.url, onDark)}</td></tr>`;
}

function heroDark(layout: EmailLayout, logo: string, base: string): string {
	const bg = `${base}/hero-oscuro.jpg`;

	return `<tr><td background="${e(bg)}" bgcolor="${BRAND.heroInk}" valign="top" style="background-color:${BRAND.heroInk};background-image:url('${e(bg)}');background-size:cover;background-position:center bottom;background-repeat:no-repeat;border-radius:20px 20px 0 0;">
<!--[if gte mso 9]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:600px;"><v:fill type="frame" src="${e(bg)}" color="${BRAND.heroInk}" aspect="atleast" /><v:textbox style="mso-fit-shape-to-text:true" inset="0,0,0,0"><![endif]-->
<div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:40px 40px 48px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:460px;">
<tr><td style="padding:0 0 40px 0;"><img src="${e(logo)}" width="140" height="35" alt="Sapira" style="display:block;border:0;outline:none;text-decoration:none;width:140px;height:35px;${font(22, 35, BRAND.white, 'font-weight:700;')}"></td></tr>
${heroCopy(layout, true)}
</table>
</td></tr>
</table>
</div>
<!--[if gte mso 9]></v:textbox></v:rect><![endif]-->
</td></tr>`;
}

function heroLight(layout: EmailLayout, base: string): string {
	return `<tr><td bgcolor="${BRAND.violetSoft}" style="background-color:${BRAND.violetSoft};border-radius:20px 20px 0 0;font-size:0;line-height:0;">
<img src="${e(`${base}/hero-claro.png`)}" width="600" alt="Sapira" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:20px 20px 0 0;${font(22, 28, BRAND.violet, 'font-weight:700;')}">
</td></tr>
<tr><td bgcolor="${BRAND.white}" style="background-color:${BRAND.white};padding:36px 40px 8px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${heroCopy(layout, false)}
</table>
</td></tr>`;
}

function roleBlock(role: NonNullable<EmailLayout['role']>, base: string): string {
	const check = `<img src="${e(`${base}/check.png`)}" width="24" height="24" alt="" style="display:block;border:0;width:24px;height:24px;">`;
	const rows = role.items
		.map((item) => {
			return `<tr>
<td width="24" valign="middle" style="padding:0 0 10px 0;width:24px;">${check}</td>
<td valign="middle" style="padding:0 0 10px 12px;${font(15, 22, BRAND.ink, 'font-weight:600;')}">${e(item.text)}</td>
</tr>`;
		})
		.join('\n');

	return `<tr><td style="padding:8px 0 28px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.tint}" style="background-color:${BRAND.tint};border:1px solid ${BRAND.violetLine};border-radius:14px;">
<tr><td style="padding:20px 22px 12px 22px;">
<div style="${font(17, 24, BRAND.ink, 'font-weight:800;')}">${e(role.title)}</div>
<div style="padding:2px 0 14px 0;${font(13, 20, BRAND.muted)}">${e(role.intro)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rows}
</table>
<div style="padding:6px 0 8px 0;${font(13, 20, BRAND.muted)}">${e(role.footnote)}</div>
</td></tr>
</table>
</td></tr>`;
}

function altLoginBlock(alt: NonNullable<EmailLayout['altLogin']>): string {
	return `<tr><td style="padding:0 0 24px 0;${font(14, 21, BRAND.muted)}">${e(alt.text)} <a href="${e(alt.url)}" target="_blank" style="color:${BRAND.violet};font-weight:700;text-decoration:underline;">${e(alt.label)}</a></td></tr>`;
}

function calloutBlock(text: string): string {
	return `<tr><td style="padding:4px 0 24px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="${BRAND.tint}" style="background-color:${BRAND.tint};border:1px solid ${BRAND.violetLine};border-radius:12px;padding:14px 18px;${font(14, 21, BRAND.body)}">${e(text)}</td>
</tr></table>
</td></tr>`;
}

function footer(logo: string): string {
	return `<tr><td bgcolor="${BRAND.ink}" align="center" style="background-color:${BRAND.ink};border-radius:0 0 20px 20px;padding:32px 40px 30px 40px;">
<img src="${e(logo)}" width="112" height="28" alt="Sapira" style="display:block;margin:0 auto;border:0;width:112px;height:28px;${font(18, 28, BRAND.white, 'font-weight:700;')}">
<div style="padding-top:14px;${font(14, 20, BRAND.onDarkBody)}">${e(FOOTER_TAGLINE)}</div>
<div style="padding-top:14px;${font(13, 20, BRAND.onDarkBody)}">Sapira · <a href="https://aisapira.com" style="color:${BRAND.lilac};text-decoration:underline;">aisapira.com</a></div>
<div style="padding-top:8px;${font(12, 18, BRAND.onDarkMuted)}">${e(FOOTER_DISCLAIMER)}</div>
</td></tr>`;
}

export function renderLayout(layout: EmailLayout, options: EmailOptions = {}): string {
	const variant = options.variant ?? 'a';
	const base = (options.assetBaseUrl || DEFAULT_ASSET_BASE_URL).replace(/\/+$/, '');
	const logo = layout.logoUrl || `${base}/logo-claro.png`;
	const preheaderSpacer = '&#847;&zwnj;&nbsp;'.repeat(40);
	const paragraphs = layout.paragraphs
		.map((text) => `<tr><td style="padding:0 0 16px 0;${font(16, 26, BRAND.body)}">${e(text)}</td></tr>`)
		.join('\n');
	const notes = layout.notes.map((text) => `<div style="padding-top:6px;${font(13, 20, BRAND.muted)}">${e(text)}</div>`).join('\n');
	const hero = variant === 'b' ? heroLight(layout, base) : heroDark(layout, logo, base);
	const bodyTop = variant === 'b' ? '20px' : '36px';

	return `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<!--[if !mso]><!--><link href="${BRAND_FONT_URL}" rel="stylesheet"><!--<![endif]-->
<!--[if mso]><style>body,table,td,div,a,h1,strong{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->
<title>${e(layout.title)}</title>
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:${BRAND.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${BRAND.page};">${e(layout.preheader)}${preheaderSpacer}</div>
<div role="article" aria-roledescription="email" aria-label="${e(layout.title)}" lang="es">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.page}" style="background-color:${BRAND.page};">
<tr><td align="center" style="padding:32px 12px;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
${hero}
<tr><td bgcolor="${BRAND.white}" style="background-color:${BRAND.white};padding:${bodyTop} 40px 32px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${paragraphs}
${layout.role ? roleBlock(layout.role, base) : ''}
${layout.altLogin ? altLoginBlock(layout.altLogin) : ''}
${layout.callout ? calloutBlock(layout.callout) : ''}
<tr><td style="padding:20px 0 0 0;border-top:1px solid ${BRAND.border};${font(13, 20, BRAND.muted)}">¿El botón no funciona? Copia este enlace en tu navegador:<br><a href="${e(layout.button.url)}" target="_blank" style="color:${BRAND.violet};text-decoration:underline;word-break:break-all;">${e(layout.button.url)}</a>
${notes}
</td></tr>
</table>
</td></tr>
${footer(logo)}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</div>
</body>
</html>`;
}

/** Versión texto plano con la misma estructura (sin depender del HTML). */
export function renderLayoutText(layout: EmailLayout): string {
	const lines: string[] = [layout.heading, '', layout.lead, '', `${layout.button.label}: ${layout.button.url}`, ''];

	lines.push(...layout.paragraphs.flatMap((p) => [p, '']));
	if (layout.role) lines.push(layout.role.title, layout.role.intro, ...layout.role.items.map((item) => `- ${item.text}`), layout.role.footnote, '');
	if (layout.altLogin) lines.push(`${layout.altLogin.text} ${layout.altLogin.label}: ${layout.altLogin.url}`, '');
	if (layout.callout) lines.push(layout.callout, '');
	lines.push(...layout.notes, '', '--', 'Sapira · aisapira.com', FOOTER_TAGLINE, FOOTER_DISCLAIMER);

	return lines.join('\n');
}

/** Asunto en una línea (sin saltos que permitan inyectar headers). */
export const oneLine = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();
