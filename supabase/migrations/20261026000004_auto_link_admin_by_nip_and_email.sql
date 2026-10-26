-- Admin 1/2 accounts can be linked automatically only when both the claimed
-- NIP and the confirmed Auth email match the trusted staff directory record.
CREATE OR REPLACE FUNCTION public.claim_employee_link() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text; v_confirmed timestamptz; v_meta jsonb;
  v_claim text; v_admin_nip text; v_status text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM public.employee_links WHERE user_id = v_uid) THEN RETURN 'linked'; END IF;

  SELECT email, email_confirmed_at, coalesce(raw_user_meta_data, '{}'::jsonb)
    INTO v_email, v_confirmed, v_meta FROM auth.users WHERE id = v_uid;
  IF v_confirmed IS NULL THEN RETURN 'unconfirmed'; END IF;

  v_claim := public.nip_key(v_meta ->> 'claimed_nip');
  IF v_claim <> '' AND nullif(btrim(v_email), '') IS NOT NULL THEN
    SELECT s.nip INTO v_admin_nip
      FROM public.staff_members s
     WHERE s.role = 'admin'
       AND s.sort IN (1, 2)
       AND public.nip_key(s.nip) = v_claim
       AND nullif(btrim(s.email), '') IS NOT NULL
       AND lower(btrim(s.email)) = lower(btrim(v_email))
     LIMIT 1;

    IF v_admin_nip IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.employee_links l
          WHERE public.nip_key(l.nip) = public.nip_key(v_admin_nip)
       ) THEN
      INSERT INTO public.employee_links (user_id, nip, linked_via)
      VALUES (v_uid, v_admin_nip, 'admin_email');
      UPDATE public.registration_requests
         SET status = 'approved', decided_at = now()
       WHERE user_id = v_uid AND status = 'pending';
      RETURN 'linked';
    END IF;
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
