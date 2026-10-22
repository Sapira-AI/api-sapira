/**
 * Sondeo de la API de Kame contra la empresa de pruebas (Fase 0 de la integración, ver
 * `front-sapira/docs/integracion-kame/sondeo-api.md`). Responde lo que la documentación de Kame no dice:
 * - si `addVenta` con un folio informado REGISTRA un DTE ya emitido o lo emite de nuevo al SII;
 * - qué hace con un folio repetido, si acepta la nota de débito y qué devuelven NC y comprobante.
 *
 * Uso (credenciales en un `.env.*` ignorado por git, nunca en el comando):
 *   DOTENV_CONFIG_PATH=.env.kame yarn kame:sondeo                 # solo lectura
 *   DOTENV_CONFIG_PATH=.env.kame yarn kame:sondeo --escribir      # crea documentos en la empresa de pruebas
 *   opciones: --folio 900001  --out <carpeta> (por defecto, fuera del repo: <tmp del sistema>/kame-sondeo)
 *
 * Variables: KAME_CLIENT_ID, KAME_CLIENT_SECRET, KAME_USUARIO (correo habilitado en Kame),
 * KAME_RUT_EMPRESA (RUT de la empresa de la credencial) y opcional KAME_API_URL.
 * Con --escribir exige KAME_RUT_EMPRESA = 10491356-3 (AMBIENTE DE PRUEBAS API): Kame no tiene
 * sandbox y la empresa de pruebas vive en la API de producción.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import axios, { AxiosError, AxiosInstance } from 'axios';

const EMPRESA_DE_PRUEBAS = '10491356-3';
/** RUT genérico válido (módulo 11) para el receptor de los documentos de prueba. */
const RECEPTOR_PRUEBA = { rut: '76.007.171-4', razonSocial: 'CLIENTE PRUEBA SAPIRA', giro: 'SERVICIOS' };

type Paso = { paso: string; metodo: string; url: string; body?: unknown; status?: number; respuesta?: unknown; error?: string; ms: number };

const args = process.argv.slice(2);
const flag = (nombre: string) => args.includes(`--${nombre}`);
const opcion = (nombre: string, porDefecto: string) => {
	const i = args.indexOf(`--${nombre}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : porDefecto;
};

const normalizarRut = (rut: string) => rut.replace(/[.\s]/g, '').toUpperCase();
const hoy = () => new Date().toISOString().slice(0, 10);
const enDias = (dias: number) => new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);

function requerida(nombre: string): string {
	const valor = process.env[nombre]?.trim();
	if (!valor) throw new Error(`Falta la variable ${nombre} (ponla en el .env que indica DOTENV_CONFIG_PATH)`);
	return valor;
}

async function main() {
	const base = (process.env.KAME_API_URL ?? 'https://api.kameone.cl').replace(/\/$/, '');
	const clientId = requerida('KAME_CLIENT_ID');
	const clientSecret = requerida('KAME_CLIENT_SECRET');
	const usuario = requerida('KAME_USUARIO');
	const rutEmpresa = normalizarRut(requerida('KAME_RUT_EMPRESA'));
	const escribir = flag('escribir');
	const folio = Number(opcion('folio', '900001'));
	const out = resolve(opcion('out', join(tmpdir(), 'kame-sondeo')));

	if (escribir && rutEmpresa !== EMPRESA_DE_PRUEBAS) {
		throw new Error(`--escribir solo contra la empresa de pruebas (${EMPRESA_DE_PRUEBAS}); KAME_RUT_EMPRESA es ${rutEmpresa}`);
	}

	const pasos: Paso[] = [];
	const registrar = async (paso: string, metodo: 'get' | 'post', url: string, http: AxiosInstance, body?: unknown) => {
		const inicio = Date.now();
		const registro: Paso = { paso, metodo: metodo.toUpperCase(), url, body, ms: 0 };
		try {
			const res = metodo === 'get' ? await http.get(url) : await http.post(url, body);
			Object.assign(registro, { status: res.status, respuesta: recortar(res.data) });
		} catch (e) {
			const err = e as AxiosError;
			Object.assign(registro, { status: err.response?.status, respuesta: recortar(err.response?.data), error: err.message });
		}
		registro.ms = Date.now() - inicio;
		pasos.push(registro);
		console.log(`${registro.status ?? '---'}  ${paso}  (${registro.ms} ms)${registro.error ? `  ${registro.error}` : ''}`);
		return registro;
	};

	// 1. Token (Auth0, client_credentials). El secreto no se guarda en el informe.
	const tokenRes = await axios.post(`${base}/oauth/token`, {
		client_id: clientId,
		client_secret: clientSecret,
		audience: `${base}/api`,
		grant_type: 'client_credentials',
	});
	pasos.push({
		paso: 'token',
		metodo: 'POST',
		url: '/oauth/token',
		status: tokenRes.status,
		respuesta: { token_type: tokenRes.data?.token_type, expires_in: tokenRes.data?.expires_in },
		ms: 0,
	});
	console.log(`${tokenRes.status}  token (expira en ${tokenRes.data?.expires_in} s)`);

	const http = axios.create({ baseURL: `${base}/api`, headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }, timeout: 60_000 });

	// 2. Lectura: maestros e informe de ventas (no escribe nada).
	await registrar('unidades de negocio', 'get', '/Maestro/getListUnidadNegocio', http);
	await registrar('vendedores', 'get', '/Maestro/getListVendedor', http);
	await registrar('ficha del receptor', 'get', `/Maestro/getListFicha?rut=${encodeURIComponent(RECEPTOR_PRUEBA.rut)}`, http);
	await registrar(
		'informe de ventas (30 días)',
		'get',
		`/Documento/getInformeVentas?page=1&per_page=20&fechaDesde=${enDias(-30)}&fechaHasta=${hoy()}`,
		http
	);

	if (escribir) {
		const venta = (folioVenta: string, comentario: string, documento = 'Factura Electrónica') => ({
			Usuario: usuario,
			Documento: documento,
			Sucursal: '',
			Rut: RECEPTOR_PRUEBA.rut,
			TipoDocumento: 'VENTA',
			Folio: folioVenta,
			RznSocial: RECEPTOR_PRUEBA.razonSocial,
			Giro: RECEPTOR_PRUEBA.giro,
			Direccion: 'AV. PRUEBA 123',
			Ciudad: 'SANTIAGO',
			Comuna: 'SANTIAGO',
			Telefono: '',
			Email: '',
			Fecha: `${hoy()}T00:00:00`,
			Comentario: comentario,
			FormaPago: '1',
			Afecto: 1000,
			Exento: 0,
			Descuento: 0,
			TipoImpto1: 'IVA',
			ValorImpto1: 190,
			total: 1190,
			FechaVencimiento: `${hoy()}T00:00:00`,
			Bodega: '',
			EsInventariable: '',
			Vendedor: '',
			Recargo: 0,
			PorcDescuento: 0,
			PorcRecargo: 0,
			Contacto: '',
			Comision: null,
			FormaCredito: '',
			FichaDireccion: '',
			CuentaEmpresaCliente: '',
			RutTransporte: '',
			RutChofer: '',
			NombreChofer: '',
			Patente: '',
			Detalle: [
				{
					Descripcion: 'Servicio de prueba Sapira',
					Cantidad: 1,
					PrecioUnitario: 1000,
					Descuento: 0,
					Total: 1000,
					UnidadMedida: 'UN',
					UnidadNegocio: process.env.KAME_UNIDAD_NEGOCIO ?? '',
					Articulo: '',
					PorcDescuento: 0,
					DescripcionDetallada: '',
					Exento: '',
					TipoExento: '',
					CuentaEmpresaVenta: '',
					TipoArticulo: 'SERVICIO',
				},
			],
			Cuotas: [],
			Referencias: [],
		});

		// 3. Venta con folio informado (el caso de Sapira: el DTE ya lo emitió api-factura) y otra sin folio.
		await registrar(`addVenta con folio ${folio}`, 'post', '/Documento/addVenta', http, venta(String(folio), 'Sondeo Sapira: folio informado'));
		const sinFolio = await registrar('addVenta sin folio', 'post', '/Documento/addVenta', http, venta('', 'Sondeo Sapira: folio automático'));
		const folioAuto = (sinFolio.respuesta as { Folio?: number } | undefined)?.Folio;

		// 4. ¿Quedaron registradas? ¿Kame generó XML con TED (lo emitió) o no?
		for (const f of [folio, folioAuto].filter(Boolean)) {
			await registrar(`getVenta folio ${f}`, 'get', `/Documento/getVenta/${encodeURIComponent('Factura Electrónica')}/${f}`, http);
			await registrar(`getDocumentoXML folio ${f}`, 'get', `/Documento/getDocumentoXML/${rutEmpresa}/33/${f}`, http);
		}

		// 5. Mismo folio otra vez: ¿lo rechaza como duplicado?
		await registrar(
			`addVenta repetida folio ${folio}`,
			'post',
			'/Documento/addVenta',
			http,
			venta(String(folio), 'Sondeo Sapira: folio repetido')
		);

		// 6. Nota de crédito que anula la venta con folio informado.
		await registrar('addNotaCredito (anula)', 'post', '/Documento/addNotaCredito', http, {
			Usuario: usuario,
			Documento: 'Nota de Crédito Electrónica',
			Sucursal: '',
			Rut: RECEPTOR_PRUEBA.rut,
			TipoDocumento: 'VENTA',
			Folio: String(folio),
			Fecha: `${hoy()}T00:00:00`,
			Comentario: 'Sondeo Sapira: NC con folio informado',
			Referencias: [
				{ TpoDocRef: 'Factura Electrónica', FolioRef: String(folio), CodRef: 1, FechaRef: `${hoy()}T00:00:00`, RazonRef: 'Anula documento' },
			],
		});

		// 7. Nota de débito: no está documentada; se prueba por addVenta.
		await registrar('addVenta como Nota de Débito', 'post', '/Documento/addVenta', http, {
			...venta(String(folio), 'Sondeo Sapira: nota de débito', 'Nota de Débito Electrónica'),
			Referencias: [
				{ TpoDocRef: 'Factura Electrónica', FolioRef: String(folio), CodRef: 3, FechaRef: `${hoy()}T00:00:00`, RazonRef: 'Corrige monto' },
			],
		});

		// 8. Comprobante contable de traspaso (cuentas por variable: dependen del plan de la empresa).
		const debe = process.env.KAME_CUENTA_DEBE ?? '1.01.05.01';
		const haber = process.env.KAME_CUENTA_HABER ?? '2.01.07.01';
		await registrar('addComprobante TRASPASO', 'post', '/Contabilidad/addComprobante', http, {
			usuario,
			tipoComprobante: 'TRASPASO',
			folio: '',
			fecha: hoy(),
			comentario: 'Sondeo Sapira: devengo de prueba',
			detalle: [
				{
					cuenta: debe,
					debe: 1000,
					haber: 0,
					comentario: 'Sondeo Sapira debe',
					rutFicha: '',
					documento: '',
					folioDocumento: '',
					unidadNegocio: '',
					fechaVencimiento: '',
					tipoMovimiento: '',
					numeroMovimiento: '',
				},
				{
					cuenta: haber,
					debe: 0,
					haber: 1000,
					comentario: 'Sondeo Sapira haber',
					rutFicha: '',
					documento: '',
					folioDocumento: '',
					unidadNegocio: '',
					fechaVencimiento: '',
					tipoMovimiento: '',
					numeroMovimiento: '',
				},
			],
		});
	}

	mkdirSync(out, { recursive: true });
	const archivo = join(out, `sondeo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
	writeFileSync(archivo, JSON.stringify({ fecha: new Date().toISOString(), base, rutEmpresa, escribir, folio, pasos }, null, 2));
	console.log(`\nInforme: ${archivo}`);
}

/** Las respuestas grandes (XML, PDF en base64) se recortan para que el informe se pueda leer. */
function recortar(data: unknown): unknown {
	if (typeof data === 'string' && data.length > 4000) return `${data.slice(0, 4000)}… (${data.length} caracteres)`;
	return data;
}

main().catch((e) => {
	console.error(e instanceof AxiosError ? `${e.response?.status} ${JSON.stringify(e.response?.data)}` : e);
	process.exit(1);
});
