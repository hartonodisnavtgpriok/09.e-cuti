-- Direktori pegawai & petugas dipindah dari JavaScript ke Supabase.
-- Berkas ini TIDAK berisi data pegawai. Data awal dimuat lewat supabase/seed/directory.sql
-- (dibuat lokal, masuk .gitignore). Jalankan migrasi ini lebih dulu, lalu seed.

CREATE OR REPLACE FUNCTION public.nip_key(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT regexp_replace(coalesce(p, ''), '\s', '', 'g')
$$;

CREATE TABLE IF NOT EXISTS public.employees (
  nip         text PRIMARY KEY,
  name        text NOT NULL,
  jabatan     text NOT NULL DEFAULT '',
  unit_code   text NOT NULL DEFAULT 'K',
  atasan_code text NOT NULL DEFAULT 'K',
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_nip_key_uq ON public.employees (public.nip_key(nip));
CREATE UNIQUE INDEX IF NOT EXISTS employees_email_uq ON public.employees (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.staff_members (
  nip   text NOT NULL,
  role  text NOT NULL CHECK (role IN ('admin', 'correspondence', 'approver')),
  name  text NOT NULL,
  title text NOT NULL DEFAULT '',
  email text,
  sort  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (nip, role)
);

CREATE TABLE IF NOT EXISTS public.unit_heads (
  code text PRIMARY KEY,
  nip  text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS public.employee_links (
  user_id    uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  nip        text NOT NULL,
  linked_via text NOT NULL DEFAULT 'email',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS employee_links_nip_uq ON public.employee_links (public.nip_key(nip));

CREATE TABLE IF NOT EXISTS public.registration_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL UNIQUE REFERENCES auth.users (id) ON DELETE CASCADE,
  email        text NOT NULL,
  claimed_name text NOT NULL DEFAULT '',
  claimed_nip  text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);

-- ---------- Fungsi bantu (identitas dibaca dari tabel, bukan dari metadata yang bisa diubah pengguna) ----------
CREATE OR REPLACE FUNCTION public.my_nip() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT nip FROM public.employee_links WHERE user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.is_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.staff_members s
                 WHERE public.nip_key(s.nip) = public.nip_key(public.my_nip()))
$$;

-- p_sort = NULL: admin mana pun; 1 = Admin 1; 2 = Admin 2
CREATE OR REPLACE FUNCTION public.is_admin(p_sort integer DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.staff_members s
                 WHERE s.role = 'admin'
                   AND public.nip_key(s.nip) = public.nip_key(public.my_nip())
                   AND (p_sort IS NULL OR s.sort = p_sort))
$$;

-- ---------- RLS & hak akses kolom ----------
ALTER TABLE public.employees             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_members         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unit_heads            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_links        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registration_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.employees, public.staff_members, public.unit_heads,
              public.employee_links, public.registration_requests FROM anon, authenticated;

-- Kolom email pegawai tidak pernah dikirim ke browser; hanya dipakai pencocokan di server.
GRANT SELECT (nip, name, jabatan, unit_code, atasan_code) ON public.employees TO authenticated;
GRANT SELECT (nip, role, name, title, sort) ON public.staff_members TO authenticated;
GRANT SELECT ON public.unit_heads TO authenticated;
GRANT SELECT ON public.employee_links TO authenticated;
GRANT SELECT ON public.registration_requests TO authenticated;

-- Pegawai dan petugas non-admin hanya melihat baris pegawai yang tertaut ke akunnya.
-- Direktori lengkap hanya tersedia bagi admin yang mengelola nominatif.
DROP POLICY IF EXISTS employees_select ON public.employees;
CREATE POLICY employees_select ON public.employees FOR SELECT TO authenticated
  USING (public.nip_key(nip) = public.nip_key(public.my_nip()) OR public.is_admin());

DROP POLICY IF EXISTS staff_members_select ON public.staff_members;
CREATE POLICY staff_members_select ON public.staff_members FOR SELECT TO authenticated
  USING (public.is_staff() OR public.nip_key(nip) = public.nip_key(public.my_nip()));

DROP POLICY IF EXISTS unit_heads_select ON public.unit_heads;
CREATE POLICY unit_heads_select ON public.unit_heads FOR SELECT TO authenticated
  USING (
    public.is_staff()
    OR code IN ('K', 'B')
    OR code IN (
      SELECT e.unit_code FROM public.employees e
       WHERE public.nip_key(e.nip) = public.nip_key(public.my_nip())
      UNION
      SELECT e.atasan_code FROM public.employees e
       WHERE public.nip_key(e.nip) = public.nip_key(public.my_nip())
    )
    OR (code = 'H' AND EXISTS (
      SELECT 1 FROM public.employees e
       WHERE public.nip_key(e.nip) = public.nip_key(public.my_nip())
         AND e.unit_code IN ('P', 'M')
    ))
    OR (code = 'L' AND EXISTS (
      SELECT 1 FROM public.employees e
       WHERE public.nip_key(e.nip) = public.nip_key(public.my_nip())
         AND e.unit_code IN ('R', 'A')
    ))
  );

DROP POLICY IF EXISTS employee_links_select_own ON public.employee_links;
CREATE POLICY employee_links_select_own ON public.employee_links FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS registration_requests_select ON public.registration_requests;
CREATE POLICY registration_requests_select ON public.registration_requests FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

-- ---------- Pendaftaran: email cocok + NIP cocok => otomatis; selain itu menunggu admin ----------
CREATE OR REPLACE FUNCTION public.claim_employee_link() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text; v_confirmed timestamptz; v_meta jsonb;
  v_claim text; v_nip text; v_status text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM public.employee_links WHERE user_id = v_uid) THEN RETURN 'linked'; END IF;

  SELECT email, email_confirmed_at, coalesce(raw_user_meta_data, '{}'::jsonb)
    INTO v_email, v_confirmed, v_meta FROM auth.users WHERE id = v_uid;
  IF v_confirmed IS NULL THEN RETURN 'unconfirmed'; END IF;

  v_claim := public.nip_key(v_meta ->> 'claimed_nip');
  v_nip := NULL;
  SELECT e.nip INTO v_nip FROM public.employees e
   WHERE e.email IS NOT NULL AND lower(e.email) = lower(v_email)
     AND v_claim <> '' AND public.nip_key(e.nip) = v_claim;
  IF v_nip IS NULL THEN
    SELECT s.nip INTO v_nip FROM public.staff_members s
     WHERE s.email IS NOT NULL AND lower(s.email) = lower(v_email)
       AND v_claim <> '' AND public.nip_key(s.nip) = v_claim LIMIT 1;
  END IF;

  IF v_nip IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.employee_links l WHERE public.nip_key(l.nip) = public.nip_key(v_nip)) THEN
    INSERT INTO public.employee_links (user_id, nip, linked_via) VALUES (v_uid, v_nip, 'email');
    UPDATE public.registration_requests SET status = 'approved', decided_at = now()
     WHERE user_id = v_uid AND status = 'pending';
    RETURN 'linked';
  END IF;

  INSERT INTO public.registration_requests (user_id, email, claimed_name, claimed_nip)
  VALUES (v_uid, v_email, left(coalesce(v_meta ->> 'full_name', ''), 200), left(coalesce(v_meta ->> 'claimed_nip', ''), 50))
  ON CONFLICT (user_id) DO UPDATE
    SET claimed_name = EXCLUDED.claimed_name, claimed_nip = EXCLUDED.claimed_nip, email = EXCLUDED.email
    WHERE public.registration_requests.status = 'pending';

  SELECT status INTO v_status FROM public.registration_requests WHERE user_id = v_uid;
  RETURN CASE WHEN v_status = 'rejected' THEN 'rejected' ELSE 'pending' END;
END $$;

CREATE OR REPLACE FUNCTION public.admin_approve_registration(p_request uuid, p_nip text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_req public.registration_requests%ROWTYPE; v_nip text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT * INTO v_req FROM public.registration_requests WHERE id = p_request AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'request_not_found'; END IF;

  SELECT nip INTO v_nip FROM public.employees WHERE public.nip_key(nip) = public.nip_key(p_nip);
  IF v_nip IS NULL THEN
    SELECT nip INTO v_nip FROM public.staff_members WHERE public.nip_key(nip) = public.nip_key(p_nip) LIMIT 1;
  END IF;
  IF v_nip IS NULL THEN RAISE EXCEPTION 'nip_not_found'; END IF;
  IF EXISTS (SELECT 1 FROM public.employee_links WHERE public.nip_key(nip) = public.nip_key(v_nip)) THEN
    RAISE EXCEPTION 'nip_taken';
  END IF;

  INSERT INTO public.employee_links (user_id, nip, linked_via) VALUES (v_req.user_id, v_nip, 'admin');
  UPDATE public.employees SET email = v_req.email, updated_at = now()
   WHERE nip = v_nip AND email IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.employees x WHERE lower(x.email) = lower(v_req.email));
  UPDATE public.registration_requests SET status = 'approved', decided_at = now() WHERE id = p_request;
END $$;

CREATE OR REPLACE FUNCTION public.admin_reject_registration(p_request uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  UPDATE public.registration_requests SET status = 'rejected', decided_at = now()
   WHERE id = p_request AND status = 'pending';
END $$;

-- ---------- Nominatif (Admin 1) ----------
-- p_rows: [{orig_nip, nip, name, jabatan, unit_code, atasan_code}]; orig_nip kosong = pegawai baru.
CREATE OR REPLACE FUNCTION public.admin_save_roster(p_rows jsonb, p_delete text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record; k text;
BEGIN
  IF NOT public.is_admin(1) THEN RAISE EXCEPTION 'forbidden'; END IF;

  FOREACH k IN ARRAY coalesce(p_delete, ARRAY[]::text[]) LOOP
    IF EXISTS (SELECT 1 FROM public.staff_members WHERE role = 'admin' AND sort <= 2 AND public.nip_key(nip) = public.nip_key(k)) THEN
      RAISE EXCEPTION 'protected_admin';
    END IF;
    DELETE FROM public.employee_links WHERE public.nip_key(nip) = public.nip_key(k);
    DELETE FROM public.staff_members  WHERE public.nip_key(nip) = public.nip_key(k);
    UPDATE public.unit_heads SET nip = '', name = '' WHERE public.nip_key(nip) = public.nip_key(k);
    DELETE FROM public.employees WHERE public.nip_key(nip) = public.nip_key(k);
  END LOOP;

  FOR r IN SELECT * FROM jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
           AS x(orig_nip text, nip text, name text, jabatan text, unit_code text, atasan_code text) LOOP
    IF btrim(coalesce(r.name, '')) = '' OR btrim(coalesce(r.nip, '')) = '' THEN RAISE EXCEPTION 'invalid_row'; END IF;

    IF btrim(coalesce(r.orig_nip, '')) = '' THEN
      INSERT INTO public.employees (nip, name, jabatan, unit_code, atasan_code)
      VALUES (btrim(r.nip), btrim(r.name), coalesce(r.jabatan, ''), coalesce(nullif(r.unit_code, ''), 'K'),
              coalesce(nullif(r.atasan_code, ''), nullif(r.unit_code, ''), 'K'));
    ELSE
      IF public.nip_key(r.orig_nip) <> public.nip_key(r.nip) AND EXISTS (
           SELECT 1 FROM public.staff_members WHERE role = 'admin' AND sort <= 2 AND public.nip_key(nip) = public.nip_key(r.orig_nip)) THEN
        RAISE EXCEPTION 'protected_admin';
      END IF;
      UPDATE public.employees
         SET nip = btrim(r.nip), name = btrim(r.name), jabatan = coalesce(r.jabatan, ''),
             unit_code = coalesce(nullif(r.unit_code, ''), unit_code),
             atasan_code = coalesce(nullif(r.atasan_code, ''), atasan_code), updated_at = now()
       WHERE public.nip_key(nip) = public.nip_key(r.orig_nip);
      IF public.nip_key(r.orig_nip) <> public.nip_key(r.nip) THEN
        UPDATE public.employee_links SET nip = btrim(r.nip) WHERE public.nip_key(nip) = public.nip_key(r.orig_nip);
        UPDATE public.staff_members  SET nip = btrim(r.nip) WHERE public.nip_key(nip) = public.nip_key(r.orig_nip);
        UPDATE public.unit_heads     SET nip = btrim(r.nip) WHERE public.nip_key(nip) = public.nip_key(r.orig_nip);
      END IF;
      UPDATE public.staff_members SET name = btrim(r.name) WHERE public.nip_key(nip) = public.nip_key(r.nip);
      UPDATE public.staff_members SET title = r.jabatan
       WHERE role = 'approver' AND coalesce(r.jabatan, '') <> '' AND public.nip_key(nip) = public.nip_key(r.nip);
      UPDATE public.unit_heads SET name = btrim(r.name) WHERE public.nip_key(nip) = public.nip_key(r.nip);
    END IF;
  END LOOP;
END $$;

-- ---------- Petugas: penyetuju / persuratan / admin (Admin 2) ----------
CREATE OR REPLACE FUNCTION public.admin_add_staff(p_role text, p_name text, p_nip text, p_title text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.is_admin(2) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF p_role NOT IN ('admin', 'correspondence', 'approver') OR btrim(coalesce(p_name, '')) = '' OR btrim(coalesce(p_nip, '')) = '' THEN
    RAISE EXCEPTION 'invalid_row';
  END IF;
  IF EXISTS (SELECT 1 FROM public.staff_members WHERE public.nip_key(nip) = public.nip_key(p_nip)) THEN
    RAISE EXCEPTION 'nip_taken';
  END IF;
  INSERT INTO public.staff_members (nip, role, name, title, sort)
  VALUES (btrim(p_nip), p_role, btrim(p_name), btrim(coalesce(p_title, '')),
          (SELECT coalesce(max(sort), 0) + 1 FROM public.staff_members WHERE role = p_role));
END $$;

CREATE OR REPLACE FUNCTION public.admin_update_staff(p_role text, p_old_nip text, p_name text, p_nip text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.is_admin(2) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF btrim(coalesce(p_name, '')) = '' OR btrim(coalesce(p_nip, '')) = '' THEN RAISE EXCEPTION 'invalid_row'; END IF;
  IF public.nip_key(p_old_nip) <> public.nip_key(p_nip) AND (
       EXISTS (SELECT 1 FROM public.staff_members WHERE public.nip_key(nip) = public.nip_key(p_nip))
       OR EXISTS (SELECT 1 FROM public.employees WHERE public.nip_key(nip) = public.nip_key(p_nip))) THEN
    RAISE EXCEPTION 'nip_taken';
  END IF;

  UPDATE public.staff_members SET name = btrim(p_name), nip = btrim(p_nip)
   WHERE role = p_role AND public.nip_key(nip) = public.nip_key(p_old_nip);
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  UPDATE public.staff_members SET name = btrim(p_name) WHERE public.nip_key(nip) = public.nip_key(p_old_nip);

  IF public.nip_key(p_old_nip) <> public.nip_key(p_nip) THEN
    UPDATE public.employee_links SET nip = btrim(p_nip) WHERE public.nip_key(nip) = public.nip_key(p_old_nip);
    UPDATE public.staff_members  SET nip = btrim(p_nip) WHERE public.nip_key(nip) = public.nip_key(p_old_nip);
    UPDATE public.unit_heads     SET nip = btrim(p_nip) WHERE public.nip_key(nip) = public.nip_key(p_old_nip);
    UPDATE public.employees      SET nip = btrim(p_nip) WHERE public.nip_key(nip) = public.nip_key(p_old_nip);
  END IF;
  UPDATE public.employees  SET name = btrim(p_name), updated_at = now() WHERE public.nip_key(nip) = public.nip_key(p_nip);
  UPDATE public.unit_heads SET name = btrim(p_name) WHERE public.nip_key(nip) = public.nip_key(p_nip);
END $$;

CREATE OR REPLACE FUNCTION public.admin_delete_staff(p_role text, p_nip text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.is_admin(2) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF p_role = 'admin' AND EXISTS (SELECT 1 FROM public.staff_members WHERE role = 'admin' AND sort <= 2 AND public.nip_key(nip) = public.nip_key(p_nip)) THEN
    RAISE EXCEPTION 'protected_admin';
  END IF;
  IF EXISTS (SELECT 1 FROM public.unit_heads WHERE public.nip_key(nip) = public.nip_key(p_nip)) THEN
    RAISE EXCEPTION 'unit_head';
  END IF;
  DELETE FROM public.staff_members WHERE role = p_role AND public.nip_key(nip) = public.nip_key(p_nip);
END $$;

REVOKE ALL ON FUNCTION public.claim_employee_link(), public.admin_approve_registration(uuid, text),
  public.admin_reject_registration(uuid), public.admin_save_roster(jsonb, text[]),
  public.admin_add_staff(text, text, text, text), public.admin_update_staff(text, text, text, text),
  public.admin_delete_staff(text, text), public.my_nip(), public.is_staff(), public.is_admin(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_employee_link(), public.admin_approve_registration(uuid, text),
  public.admin_reject_registration(uuid), public.admin_save_roster(jsonb, text[]),
  public.admin_add_staff(text, text, text, text), public.admin_update_staff(text, text, text, text),
  public.admin_delete_staff(text, text), public.my_nip(), public.is_staff(), public.is_admin(integer)
  TO authenticated;

-- ---------- Akun lama: tautkan NIP dari metadata hanya bila TEPAT SATU akun mengklaimnya ----------
-- Metadata dapat diubah pengguna, jadi admin tetap harus meninjau tabel employee_links setelah migrasi.
INSERT INTO public.employee_links (user_id, nip, linked_via)
SELECT u.id, coalesce(e.nip, s.nip), 'migration'
FROM auth.users u
LEFT JOIN public.employees e ON public.nip_key(e.nip) = public.nip_key(u.raw_user_meta_data ->> 'nip')
LEFT JOIN LATERAL (SELECT nip FROM public.staff_members
                    WHERE public.nip_key(nip) = public.nip_key(u.raw_user_meta_data ->> 'nip') LIMIT 1) s ON true
WHERE coalesce(e.nip, s.nip) IS NOT NULL
  AND (SELECT count(*) FROM auth.users u2
        WHERE public.nip_key(u2.raw_user_meta_data ->> 'nip') = public.nip_key(u.raw_user_meta_data ->> 'nip')) = 1
ON CONFLICT DO NOTHING;

-- ---------- Tutup kebocoran data pribadi di tabel lama (bila ada) ----------
DO $$
BEGIN
  IF to_regclass('public.leave_balances') IS NOT NULL THEN
    DROP POLICY IF EXISTS "leave_balances_select" ON public.leave_balances;
    CREATE POLICY "leave_balances_select" ON public.leave_balances FOR SELECT TO authenticated
      USING (public.is_staff() OR public.nip_key(nip) = public.nip_key(public.my_nip()));
  END IF;
  IF to_regclass('public.app_settings') IS NOT NULL THEN
    DROP POLICY IF EXISTS "app_settings_directory_keys_admin_only" ON public.app_settings;
    CREATE POLICY "app_settings_directory_keys_admin_only" ON public.app_settings AS RESTRICTIVE FOR SELECT
      USING (key NOT IN ('employee_roster', 'additional_approvers', 'additional_correspondence',
                         'additional_admins', 'staff_config') OR public.is_admin());
  END IF;
END $$;
