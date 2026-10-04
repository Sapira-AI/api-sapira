import { USER_AVATARS_BUCKET } from './me.constants';
import { userAvatar, userAvatarUrl } from './user-avatar';

describe('userAvatar', () => {
	const PATH = 'users/1dedf14a-ba51-4b93-9c74-7f869e17d4dc/8629d9cd-9384-4088-b81e-1ed43c3f4737.png';

	it('foto subida → upload con la URL pública del bucket (la foto manda sobre el preset)', () => {
		expect(userAvatar({ avatar_path: PATH, avatar_preset: 'preset-02' }, 'https://sb.co/')).toEqual({
			kind: 'upload',
			url: `https://sb.co/storage/v1/object/public/${USER_AVATARS_BUCKET}/${PATH}`,
		});
	});

	it('preset de la lista → preset; preset desconocido o sin datos → initials', () => {
		expect(userAvatar({ avatar_preset: 'preset-03' })).toEqual({ kind: 'preset', preset_id: 'preset-03' });
		expect(userAvatar({ avatar_preset: 'preset-99' })).toEqual({ kind: 'initials' });
		expect(userAvatar({ avatar_path: null, avatar_preset: null })).toEqual({ kind: 'initials' });
		expect(userAvatar(null)).toEqual({ kind: 'initials' });
	});

	it('sin URL explícita usa SUPABASE_URL del entorno', () => {
		const previous = process.env.SUPABASE_URL;

		process.env.SUPABASE_URL = 'https://env.supabase.co';
		try {
			expect(userAvatarUrl('a.png')).toBe(`https://env.supabase.co/storage/v1/object/public/${USER_AVATARS_BUCKET}/a.png`);
			expect(userAvatar({ avatar_path: 'a.png' })).toEqual({ kind: 'upload', url: userAvatarUrl('a.png') });
		} finally {
			if (previous === undefined) delete process.env.SUPABASE_URL;
			else process.env.SUPABASE_URL = previous;
		}
	});
});
