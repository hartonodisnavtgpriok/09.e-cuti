-- NIP yang dikirim pengguna adalah klaim, bukan bukti identitas. Semua klaim
-- baru harus diverifikasi Admin sebelum dibuatkan employee_link.
CREATE OR REPLACE FUNCTION public.claim_employee_link() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text; v_confirmed timestamptz; v_meta jsonb; v_status text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM public.employee_links WHERE user_id = v_uid) THEN RETURN 'linked'; END IF;

  SELECT email, email_confirmed_at, coalesce(raw_user_meta_data, '{}'::jsonb)
    INTO v_email, v_confirmed, v_meta FROM auth.users WHERE id = v_uid;
  IF v_confirmed IS NULL THEN RETURN 'unconfirmed'; END IF;

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

-- Revoke links created by the vulnerable NIP-only auto-link flow and put those
-- accounts back into the Admin review queue. These links were not verified.
INSERT INTO public.registration_requests (user_id, email, claimed_name, claimed_nip)
SELECT l.user_id,
       u.email,
       left(coalesce(u.raw_user_meta_data ->> 'full_name', ''), 200),
       left(coalesce(u.raw_user_meta_data ->> 'claimed_nip', l.nip), 50)
  FROM public.employee_links l
  JOIN auth.users u ON u.id = l.user_id
 WHERE l.linked_via = 'nip'
ON CONFLICT (user_id) DO UPDATE
  SET email = EXCLUDED.email,
      claimed_name = EXCLUDED.claimed_name,
      claimed_nip = EXCLUDED.claimed_nip,
      status = 'pending',
      decided_at = NULL;

DELETE FROM public.employee_links WHERE linked_via = 'nip';
