import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
serve(async (req) => {
	// Handle CORS preflight requests
	if (req.method === 'OPTIONS') {
		return new Response(null, {
			headers: corsHeaders,
		});
	}
	try {
		// Get Supabase client
		const supabaseClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
			global: {
				headers: {
					Authorization: req.headers.get('Authorization'),
				},
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

		const { username, password, securityToken, clientId, clientSecret, loginUrl } = await req.json();
		// Validate required fields
		if (!username || !password || !securityToken || !clientId || !clientSecret) {
			throw new Error('Missing required fields');
		}
		const baseLoginUrl = loginUrl || 'https://login.salesforce.com';
		// Prepare OAuth2 password grant request
		const passwordWithToken = `${password}${securityToken}`;
		const params = new URLSearchParams({
			grant_type: 'password',
			client_id: clientId,
			client_secret: clientSecret,
			username: username,
			password: passwordWithToken,
		});
		// Authenticate with Salesforce
		const response = await fetch(`${baseLoginUrl}/services/oauth2/token`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: params.toString(),
		});
		if (!response.ok) {
			const errorData = await response.text();
			console.error('Salesforce auth error:', errorData);
			throw new Error(`Salesforce authentication failed: ${response.statusText}`);
		}
		const authData = await response.json();

		console.log('✅ Salesforce authentication successful');
		console.log('📝 Storing tokens in database...');

		// Store credentials in database
		const { error: dbError } = await supabaseClient.from('salesforce_connections').upsert(
			{
				user_id: user.id,
				holding_id: holdingId,
				username: username,
				client_id: clientId,
				client_secret: clientSecret,
				security_token: securityToken,
				login_url: baseLoginUrl,
				access_token: authData.access_token,
				refresh_token: authData.refresh_token,
				instance_url: authData.instance_url,
				salesforce_user_id: authData.id,
				token_issued_at: new Date(parseInt(authData.issued_at)),
				is_active: true,
				last_sync_at: new Date(),
			},
			{
				onConflict: 'holding_id',
			}
		);
		if (dbError) {
			console.error('Database error:', dbError);
			throw new Error('Failed to store connection');
		}
		return new Response(
			JSON.stringify({
				success: true,
				message: 'Successfully connected to Salesforce',
				instanceUrl: authData.instance_url,
			}),
			{
				headers: {
					...corsHeaders,
					'Content-Type': 'application/json',
				},
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
				headers: {
					...corsHeaders,
					'Content-Type': 'application/json',
				},
				status: 400,
			}
		);
	}
});
