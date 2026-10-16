-- Tabel untuk menyimpan data pengguna yang terdaftar di OneSignal.
-- Dipakai oleh klien saat registrasi push dan oleh server saat mengirim notifikasi.

CREATE TABLE IF NOT EXISTS public.one_signal_users (
  user_id     TEXT PRIMARY KEY,        -- Supabase auth user id (external_id OneSignal)
  role        TEXT,
  nip         TEXT,
  name        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Izinkan RLS agar hanya pemilik yang dapat mengubah datanya sendiri.
ALTER TABLE public.one_signal_users ENABLE ROW LEVEL SECURITY;

-- Semua pengguna terautentikasi boleh membaca tabel ini (diperlukan untuk mencari
-- external_id penerima berdasarkan NIP saat mengirim notifikasi). Tabel ini hanya
-- menyimpan user_id, role, nip, nama — bukan data sensitif.
DROP POLICY IF EXISTS "one_signal_users_select_auth" ON public.one_signal_users;
CREATE POLICY "one_signal_users_select_auth"
  ON public.one_signal_users FOR SELECT
  USING (auth.role() = 'authenticated');

-- Pengguna hanya dapat menambah & mengubah baris miliknya sendiri.
-- auth.uid() mengembalikan tipe uuid, jadi kolom user_id (text) di-cast ke uuid
-- agar perbandingannya uuid = uuid (menghindari error "operator does not exist: uuid = text").
DROP POLICY IF EXISTS "one_signal_users_insert_own" ON public.one_signal_users;
CREATE POLICY "one_signal_users_insert_own"
  ON public.one_signal_users FOR INSERT
  WITH CHECK (user_id::uuid = auth.uid());

DROP POLICY IF EXISTS "one_signal_users_update_own" ON public.one_signal_users;
CREATE POLICY "one_signal_users_update_own"
  ON public.one_signal_users FOR UPDATE
  USING (user_id::uuid = auth.uid())
  WITH CHECK (user_id::uuid = auth.uid());

-- Indeks untuk pencarian cepat berdasarkan NIP (berguna saat mengirim notifikasi ke pemohon).
CREATE INDEX IF NOT EXISTS idx_one_signal_users_nip ON public.one_signal_users (nip);
