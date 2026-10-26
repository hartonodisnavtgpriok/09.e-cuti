-- Tautkan akun berdasarkan NIP terdaftar; email direktori pegawai bukan identitas login.
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
  IF v_claim <> '' THEN
    SELECT e.nip INTO v_nip FROM public.employees e
     WHERE public.nip_key(e.nip) = v_claim;
    IF v_nip IS NULL THEN
      SELECT s.nip INTO v_nip FROM public.staff_members s
       WHERE public.nip_key(s.nip) = v_claim LIMIT 1;
    END IF;
  END IF;

  IF v_nip IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.employee_links l
     WHERE public.nip_key(l.nip) = public.nip_key(v_nip)
  ) THEN
    INSERT INTO public.employee_links (user_id, nip, linked_via)
    VALUES (v_uid, v_nip, 'nip');
    UPDATE public.registration_requests SET status = 'approved', decided_at = now()
     WHERE user_id = v_uid AND status = 'pending';
    RETURN 'linked';
  END IF;

  INSERT INTO public.registration_requests (user_id, email, claimed_name, claimed_nip)
  VALUES (
    v_uid,
    v_email,
    left(coalesce(v_meta ->> 'full_name', ''), 200),
    left(coalesce(v_meta ->> 'claimed_nip', ''), 50)
  )
  ON CONFLICT (user_id) DO UPDATE
    SET claimed_name = EXCLUDED.claimed_name,
        claimed_nip = EXCLUDED.claimed_nip,
        email = EXCLUDED.email
    WHERE public.registration_requests.status = 'pending';

  SELECT status INTO v_status FROM public.registration_requests WHERE user_id = v_uid;
  RETURN CASE WHEN v_status = 'rejected' THEN 'rejected' ELSE 'pending' END;
END $$;

-- Jangan menimpa email resmi/lama di direktori dengan email akun pengguna.
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
  UPDATE public.registration_requests SET status = 'approved', decided_at = now() WHERE id = p_request;
END $$;
