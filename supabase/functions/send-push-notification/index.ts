// Edge Function: send-push-notification
// Mengirim push notification ke pengguna tertentu melalui OneSignal REST API.
// Dipanggil oleh klien setelah status pengajuan cuti berubah.
//
// Secret yang diperlukan (set via `supabase secrets set`):
//   ONESIGNAL_APP_ID      -> App ID OneSignal
//   ONESIGNAL_REST_API_KEY -> REST API Key OneSignal (bukan App ID!)
//
// Payload POST (JSON):
//   {
//     "external_id": "<supabase_auth_user_id>",   // target penerima
//     "title":       "Judul notifikasi",
//     "body":        "Isi notifikasi",
//     "url":         "https://... (opsional)"     // dibuka saat notifikasi diklik
//   }

const ONESIGNAL_APP_ID = Deno.env.get('ONESIGNAL_APP_ID');
const ONESIGNAL_REST_API_KEY = Deno.env.get('ONESIGNAL_REST_API_KEY');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method tidak diizinkan.' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
    console.error('OneSignal belum dikonfigurasi. Set ONESIGNAL_APP_ID dan ONESIGNAL_REST_API_KEY.');
    return new Response(JSON.stringify({ error: 'Konfigurasi OneSignal belum diatur di server.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let payload: { external_id?: string; title?: string; body?: string; url?: string };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Payload JSON tidak valid.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { external_id, title, body, url } = payload;
  if (!external_id || !body) {
    return new Response(JSON.stringify({ error: 'external_id dan body wajib diisi.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const oneSignalPayload: Record<string, unknown> = {
    app_id: ONESIGNAL_APP_ID,
    include_aliases: { external_id: [external_id] },
    target_channel: 'push',
    contents: { en: body },
  };

  if (title) oneSignalPayload.headings = { en: title };
  if (url) oneSignalPayload.url = url;

  try {
    const res = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        Authorization: `Key ${ONESIGNAL_REST_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(oneSignalPayload),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error('OneSignal gagal:', res.status, text);
      return new Response(
        JSON.stringify({ error: 'OneSignal menolak permintaan.', status: res.status, detail: text }),
        { status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }

    return new Response(JSON.stringify({ ok: true, data }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Gagal memanggil OneSignal:', err);
    return new Response(JSON.stringify({ error: 'Gagal menghubungi OneSignal.' }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
