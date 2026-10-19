-- TABEL leave_balances - PASTIKAN ADA DAN HANYA ADMIN 1 YANG BOLEH TULIS
-- Jalankan ini di Supabase > SQL Editor

-- 1. Buat tabel jika belum ada
create table if not exists public.leave_balances (
  nip text primary key,
  data jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2. Enable RLS
alter table public.leave_balances enable row level security;

-- 3. Hapus policy lama
drop policy if exists "leave_balances_select" on public.leave_balances;
drop policy if exists "leave_balances_all_admin" on public.leave_balances;
drop policy if exists "leave_balances_admin2_only" on public.leave_balances;
drop policy if exists "leave_balances_admin1_only" on public.leave_balances;

-- 4. Policy baru: semua orang boleh BACA, hanya Admin 1 yang boleh TULIS
create policy "leave_balances_select" on public.leave_balances for select using (true);

create policy "leave_balances_admin1_only" on public.leave_balances
for all using (
  -- Admin 1 = Hermansyah
  exists (select 1 from public.profiles where id = auth.uid() and nip in ('19800204 201503 1 001','198002042015031001'))
  OR
  exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','admin1'))
) with check (
  exists (select 1 from public.profiles where id = auth.uid() and nip in ('19800204 201503 1 001','198002042015031001'))
  OR
  exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','admin1'))
);

-- 5. Test: cek isi
select nip, data->>'name' as nama, data->>'n' as n, data->>'n1' as n1, data->>'n2' as n2, data->>'tahun' as tahun from public.leave_balances order by data->>'name';

-- 6. Contoh isi manual dari SQL (jika mau isi lewat Supabase langsung, tanpa UI):
-- insert into public.leave_balances (nip, data) values
-- ('19791228 202521 1 018', '{"nip":"19791228 202521 1 018","name":"HARTONO","tahun":2025,"n":12,"n1":2,"n2":0,"ket_n":"","ket_n1":"sisa 2024","ket_n2":""}'::jsonb)
-- on conflict (nip) do update set data = excluded.data, updated_at = now();
