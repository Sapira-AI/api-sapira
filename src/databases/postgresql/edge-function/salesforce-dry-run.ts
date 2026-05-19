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
			const { connectionId, syncType = 'delta' } = body;
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
			const { data: mappings, error: mappingsError } = await supabaseAdmin
				.from('integration_salesforce_field_mappings')
				.select('*')
				.eq('connection_id', connectionId);
			if (mappingsError) {
				return errorResponse(mappingsError.message, 500);
			}
			let details = [];
			if (mappings && mappings.length > 0) {
				const mappingIds = mappings.map((row) => row.id);
				const { data: detailRows, error: detailsError } = await supabaseAdmin
					.from('integration_salesforce_mapping_details')
					.select('field_mapping_id,salesforce_value,sapira_value,transform,notes')
					.in('field_mapping_id', mappingIds);
				if (detailsError) {
					return errorResponse(detailsError.message, 500);
				}
				details = detailRows ?? [];
			}
			const { data: run, error: runError } = await supabaseAdmin
				.from('integration_salesforce_sync_runs')
				.insert({
					connection_id: connection.id,
					holding_id: connection.holding_id,
					company_id: connection.company_id,
					sync_type: syncType,
					status: 'pending',
					mode: 'bulk',
					direction: 'import',
					metadata: {
						preview: true,
						requested_by: user.email ?? user.id,
						created_at: new Date().toISOString(),
					},
				})
				.select('*')
				.single();
			if (runError || !run) {
				return errorResponse(runError?.message ?? 'Failed to create sync run', 500);
			}
			const summary = {
				run: {
					id: run.id,
					sync_type: syncType,
					created_at: run.started_at,
				},
				connection: {
					id: connection.id,
					name: connection.name,
					holding_id: connection.holding_id,
					company_id: connection.company_id,
				},
				mappings: {
					total: mappings?.length ?? 0,
					byTable:
						mappings?.reduce((acc, mapping) => {
							acc[mapping.sapira_table] = (acc[mapping.sapira_table] || 0) + 1;
							return acc;
						}, {}) ?? {},
					byDirection:
						mappings?.reduce((acc, mapping) => {
							acc[mapping.direction] = (acc[mapping.direction] || 0) + 1;
							return acc;
						}, {}) ?? {},
				},
				mappingDetails: {
					total: details.length,
					examples: details.slice(0, 5),
				},
			};
			const { error: updateError } = await supabaseAdmin
				.from('integration_salesforce_sync_runs')
				.update({
					status: 'success',
					metadata: {
						...run.metadata,
						preview: true,
						generated_at: new Date().toISOString(),
						summary,
					},
				})
				.eq('id', run.id);
			if (updateError) {
				return errorResponse(updateError.message, 500);
			}
			return okResponse(summary);
		} catch (error) {
			console.error('[salesforce-dry-run]', error);
			return errorResponse('Unexpected server error', 500);
		}
	},
	{
		port: 8000,
	}
);
