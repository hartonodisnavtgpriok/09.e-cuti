INSERT INTO public.app_settings (key, value, updated_at)
VALUES (
  'social_links',
  jsonb_build_object(
    'youtube', 'https://youtube.com/@djpldisnavpriok?si=jePh1v4sTCApc6X1',
    'facebook', 'https://www.facebook.com/share/p/19qQkXZu3R/',
    'instagram', 'https://www.instagram.com/p/De8rtZmAQ5n/?utm_source=ig_web_copy_link&obrf=MzRlODBiNWFlZA==&srtk=MzRlODBiNWFlZA==',
    'x', 'https://x.com/disnavpriok',
    'tiktok', 'https://www.tiktok.com/@djpl_disnavpriok',
    'threads', 'https://www.threads.com/@djpl_disnavpriok',
    'whatsapp', 'https://whatsapp.com/channel/0029VauUGhuDOQIObBFguN1s'
  ),
  now()
)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = EXCLUDED.updated_at;
