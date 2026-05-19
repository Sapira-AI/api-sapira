import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.5';
const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const okResponse = (body, init = {}) =>
	new Response(JSON.stringify(body), {
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders,
		},
		...init,
	});
const errorResponse = (message, status = 400) =>
	okResponse(
		{
			error: message,
		},
		{
			status,
		}
	);
const escapeXml = (value) =>
	value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&apos;');
const buildSoapEnvelope = (username, password, securityToken) => {
	const passwordToken = `${password}${securityToken}`;
	return `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Body>
    <n1:login xmlns:n1="urn:partner.soap.sforce.com">
      <n1:username>${escapeXml(username)}</n1:username>
      <n1:password>${escapeXml(passwordToken)}</n1:password>
    </n1:login>
  </env:Body>
</env:Envelope>`;
};
const extractTag = (payload, tagName) => {
	const match = payload.match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`));
	return match?.[1] ?? null;
};
const normalizeReference = (reference) => reference.trim();
const deriveSecretEnvKey = (reference) => {
	if (!reference) return null;
	const normalized = normalizeReference(reference);
	const cleaned = normalized.replace(/^secret:\/\//i, '');
	if (!cleaned) return null;
	const slug = cleaned.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
	return `SALESFORCE_SECRET_${slug}`;
};
const loadSecret = (reference) => {
	const envKey = deriveSecretEnvKey(reference);
	const raw = envKey ? Deno.env.get(envKey) : null;
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed.password && parsed.security_token) {
				return parsed;
			}
		} catch (error) {
			console.error(`[salesforce-test-connection] Failed to parse secret ${envKey}:`, error);
		}
	}
	const password = Deno.env.get('SALESFORCE_PASSWORD');
	const securityToken = Deno.env.get('SALESFORCE_SECURITY_TOKEN');
	if (password && securityToken) {
		return {
			password,
			security_token: securityToken,
			api_version: Deno.env.get('SALESFORCE_API_VERSION') ?? undefined,
		};
	}
	return null;
};
const attemptLogin = async (loginUrl, username, secret) => {
	const apiVersion = secret.api_version ?? '58.0';
	const endpoint = `${loginUrl.replace(/\/$/, '')}/services/Soap/u/${apiVersion}`;
	const soapEnvelope = buildSoapEnvelope(username, secret.password, secret.security_token);
	const controller = new AbortController();
	const timeoutMs = secret.timeout_ms ?? 10_000;
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/xml; charset=utf-8',
				SOAPAction: 'login',
			},
			body: soapEnvelope,
			signal: controller.signal,
		});
		const payload = await response.text();
		if (!response.ok) {
			throw new Error(`Salesforce login failed with status ${response.status}: ${payload}`);
		}
		if (payload.includes('<faultcode>')) {
			const messageMatch = payload.match(/<faultstring>([^<]+)<\/faultstring>/);
			const message = messageMatch?.[1] ?? 'Salesforce SOAP fault';
			throw new Error(message);
		}
		const sessionId = extractTag(payload, 'sessionId');
		const serverUrl = extractTag(payload, 'serverUrl');
		const userId = extractTag(payload, 'userId');
		if (!sessionId || !serverUrl || !userId) {
			throw new Error('Salesforce login succeeded but response is missing required fields');
		}
		return {
			sessionId,
			serverUrl,
			userId,
		};
	} catch (error) {
		if (error.name === 'AbortError') {
			throw new Error(`Salesforce login timed out after ${timeoutMs}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
};
serve(
	async (req) => {
		if (req.method === 'OPTIONS') {
			return new Response(null, {
				headers: corsHeaders,
			});
		}
		try {
			if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
				console.error('Missing Supabase configuration');
				return errorResponse('Server configuration error', 500);
			}
			const authHeader = req.headers.get('Authorization');
			if (!authHeader) {
				return errorResponse('Missing authorization header', 401);
			}
			const body = await req.json().catch(() => null);
			if (!body || !body.connectionId) {
				return errorResponse('Missing connectionId', 400);
			}
			const { connectionId } = body;
			const supabaseUserClient = createClient(SUPABASE_URL, ANON_KEY, {
				global: {
					headers: {
						Authorization: authHeader,
					},
				},
			});
			const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
			const {
				data: { user },
				error: userError,
			} = await supabaseUserClient.auth.getUser();
			if (userError || !user) {
				return errorResponse('Invalid JWT', 401);
			}
			const { data: connection, error: connectionError } = await supabaseAdmin
				.from('integration_salesforce_connections')
				.select('*')
				.eq('id', connectionId)
				.maybeSingle();
			if (connectionError || !connection) {
				return errorResponse('Connection not found', 404);
			}
			const { data: appUser, error: appUserError } = await supabaseAdmin.from('users').select('id').eq('auth_id', user.id).maybeSingle();
			if (appUserError || !appUser) {
				return errorResponse('Forbidden', 403);
			}
			const { data: userHolding, error: holdingError } = await supabaseAdmin
				.from('user_holdings')
				.select('holding_id')
				.eq('user_id', appUser.id)
				.eq('holding_id', connection.holding_id)
				.maybeSingle();
			if (holdingError || !userHolding) {
				return errorResponse('Forbidden', 403);
			}
			if (!connection.username) {
				return errorResponse('Connection is missing username', 400);
			}
			const secret = loadSecret(connection.secret_reference);
			if (!secret) {
				return errorResponse('Missing Salesforce secret for connection', 400);
			}
			const loginUrl = connection.login_url ?? 'https://login.salesforce.com';
			const testedAt = new Date().toISOString();
			try {
				const loginResult = await attemptLogin(loginUrl, connection.username, secret);
				const metadata = connection.metadata ?? {};
				const updatedMetadata = {
					...metadata,
					last_connection_test: testedAt,
					last_connection_test_status: 'success',
					last_connection_test_user: user.email ?? user.id,
					last_connection_test_server: loginResult.serverUrl,
				};
				const { error: updateError } = await supabaseAdmin
					.from('integration_salesforce_connections')
					.update({
						status: 'connected',
						error_message: null,
						metadata: updatedMetadata,
						updated_at: testedAt,
					})
					.eq('id', connection.id);
				if (updateError) {
					console.error('[salesforce-test-connection] Failed to update connection status', updateError);
				}
				return okResponse({
					ok: true,
					tested_at: testedAt,
					result: {
						user_id: loginResult.userId,
						server_url: loginResult.serverUrl,
					},
				});
			} catch (error) {
				const message = error.message ?? 'Salesforce login failed';
				const metadata = connection.metadata ?? {};
				const updatedMetadata = {
					...metadata,
					last_connection_test: testedAt,
					last_connection_test_status: 'error',
					last_connection_test_user: user.email ?? user.id,
					last_connection_test_error: message,
				};
				const { error: updateError } = await supabaseAdmin
					.from('integration_salesforce_connections')
					.update({
						status: 'error',
						error_message: message,
						metadata: updatedMetadata,
						updated_at: testedAt,
					})
					.eq('id', connection.id);
				if (updateError) {
					console.error('[salesforce-test-connection] Failed to update error status', updateError);
				}
				return errorResponse(message, 502);
			}
		} catch (error) {
			console.error('[salesforce-test-connection]', error);
			return errorResponse('Unexpected server error', 500);
		}
	},
	{
		port: 8000,
	}
);
