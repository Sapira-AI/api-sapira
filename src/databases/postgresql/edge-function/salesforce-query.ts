import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface QueryRequest {
	query: string;
}

serve(async (req) => {
	// Handle CORS preflight requests
	if (req.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders });
	}

	try {
		// Get Supabase client
		const supabaseClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
			global: {
				headers: { Authorization: req.headers.get('Authorization')! },
			},
		});

		// Get authenticated user
		const {
			data: { user },
		} = await supabaseClient.auth.getUser();

		if (!user) {
			throw new Error('Unauthorized');
		}

		// Obtener holding_id del usuario
		const { data: holdingId, error: holdingError } = await supabaseClient.rpc('get_current_user_holding_id');

		if (holdingError || !holdingId) {
			throw new Error('No se pudo obtener el holding del usuario');
		}

		// Get Salesforce connection from database (por holding_id, no user_id)
		const { data: connection, error: connError } = await supabaseClient
			.from('salesforce_connections')
			.select('*')
			.eq('holding_id', holdingId)
			.eq('is_active', true)
			.maybeSingle();

		if (connError || !connection) {
			throw new Error('No active Salesforce connection found. Please connect first.');
		}

		const { query } = (await req.json()) as QueryRequest;

		if (!query) {
			throw new Error('Query is required');
		}

		console.log('📝 Received SOQL query:', query);

		// Execute SOQL query
		const queryUrl = `${connection.instance_url}/services/data/v58.0/query?q=${encodeURIComponent(query)}`;
		console.log('🌐 Salesforce API URL:', queryUrl);

		const response = await fetch(queryUrl, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${connection.access_token}`,
				'Content-Type': 'application/json',
			},
		});

		if (!response.ok) {
			let errorData;
			let errorText = '';

			try {
				errorText = await response.text();
				console.error('❌ Salesforce API error (raw text):', errorText);

				// Intentar parsear como JSON
				try {
					errorData = JSON.parse(errorText);
					console.error('❌ Salesforce API error (parsed JSON):', JSON.stringify(errorData, null, 2));
				} catch {
					// Si no es JSON válido, usar el texto tal cual
					errorData = errorText;
					console.error('❌ Salesforce API error (not JSON):', errorText);
				}
			} catch (e) {
				console.error('❌ Error reading response:', e);
				errorData = 'Unable to read error response';
			}

			// If token expired, try to refresh it automatically
			if (response.status === 401) {
				console.log('🔄 Token expired, attempting automatic refresh...');
				console.log('📋 Connection info:', {
					hasRefreshToken: !!connection.refresh_token,
					loginUrl: connection.login_url,
					clientId: connection.client_id ? 'present' : 'missing',
					clientSecret: connection.client_secret ? 'present' : 'missing',
				});

				// Intentar refresh automático
				if (connection.refresh_token) {
					try {
						console.log('🔑 Refreshing token using refresh_token...');

						const refreshParams = new URLSearchParams({
							grant_type: 'refresh_token',
							client_id: connection.client_id,
							client_secret: connection.client_secret,
							refresh_token: connection.refresh_token,
						});

						const refreshResponse = await fetch(`${connection.login_url || 'https://login.salesforce.com'}/services/oauth2/token`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
							body: refreshParams.toString(),
						});

						if (refreshResponse.ok) {
							const refreshData = await refreshResponse.json();
							console.log('✅ Token refreshed successfully, retrying query...');

							// Actualizar token en base de datos
							const updateData: any = {
								access_token: refreshData.access_token,
								token_issued_at: new Date(parseInt(refreshData.issued_at)),
								last_sync_at: new Date(),
							};

							if (refreshData.refresh_token) {
								updateData.refresh_token = refreshData.refresh_token;
							}

							await supabaseClient.from('salesforce_connections').update(updateData).eq('holding_id', holdingId);

							// Reintentar la query original con el nuevo token
							const retryResponse = await fetch(queryUrl, {
								method: 'GET',
								headers: {
									Authorization: `Bearer ${refreshData.access_token}`,
									'Content-Type': 'application/json',
								},
							});

							if (retryResponse.ok) {
								const retryData = await retryResponse.json();
								console.log('✅ Query successful after token refresh');

								return new Response(
									JSON.stringify({
										success: true,
										data: retryData,
										tokenRefreshed: true, // Indicar que se renovó el token
									}),
									{
										headers: { ...corsHeaders, 'Content-Type': 'application/json' },
										status: 200,
									}
								);
							}
						} else {
							console.error('❌ Refresh token also expired or invalid');
							// Marcar conexión como inactiva
							await supabaseClient.from('salesforce_connections').update({ is_active: false }).eq('holding_id', holdingId);
						}
					} catch (refreshError) {
						console.error('❌ Error during token refresh:', refreshError);
					}
				}

				// Si llegamos aquí, el refresh falló o no hay refresh_token
				return new Response(
					JSON.stringify({
						success: false,
						error: 'Salesforce token expired. Please reconnect.',
						errorCode: 'TOKEN_EXPIRED',
						details: errorData,
					}),
					{
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						status: 401,
					}
				);
			}

			// Extraer mensaje y código de error de Salesforce
			let errorMsg = response.statusText;
			let errorCode = 'UNKNOWN_ERROR';

			if (Array.isArray(errorData) && errorData.length > 0) {
				// Salesforce devuelve array de errores
				const sfError = errorData[0];
				errorMsg = sfError.message || errorMsg;
				errorCode = sfError.errorCode || errorCode;

				console.error(`❌ Salesforce error: [${errorCode}] ${errorMsg}`);
			} else if (typeof errorData === 'object' && errorData.message) {
				// Error en formato objeto
				errorMsg = errorData.message;
				errorCode = errorData.errorCode || errorCode;
			} else if (typeof errorData === 'string') {
				errorMsg = errorData;
			}

			console.error(`❌ Salesforce query error: ${errorCode} - ${errorMsg}`);
			console.error(`❌ Full error data:`, JSON.stringify(errorData, null, 2));

			// Devolver error completo al frontend
			return new Response(
				JSON.stringify({
					success: false,
					error: errorMsg,
					errorCode: errorCode,
					details: errorData,
					statusCode: response.status,
					rawError: errorText, // Incluir texto raw para debugging
				}),
				{
					headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					status: 400,
				}
			);
		}

		const data = await response.json();

		// Update last sync time
		await supabaseClient.from('salesforce_connections').update({ last_sync_at: new Date() }).eq('holding_id', holdingId);

		return new Response(
			JSON.stringify({
				success: true,
				data: data,
			}),
			{
				headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				status: 200,
			}
		);
	} catch (error) {
		console.error('Error:', error);
		return new Response(
			JSON.stringify({
				success: false,
				error: error.message,
			}),
			{
				headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				status: 400,
			}
		);
	}
});
