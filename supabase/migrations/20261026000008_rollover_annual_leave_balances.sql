CREATE OR REPLACE FUNCTION public.rollover_leave_balances() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row record;
  v_target_year integer := extract(year FROM (now() AT TIME ZONE 'Asia/Jakarta'))::integer;
  v_year integer;
  v_n integer;
  v_n1 integer;
  v_n2 integer;
BEGIN
  FOR v_row IN
    SELECT nip, data
      FROM public.leave_balances
     WHERE coalesce(nullif(data ->> 'tahun', '')::integer, v_target_year) < v_target_year
     FOR UPDATE
  LOOP
    v_year := coalesce(nullif(v_row.data ->> 'tahun', '')::integer, v_target_year);
    v_n := CASE WHEN coalesce(v_row.data ->> 'n', '') ~ '^[0-9]+$' THEN (v_row.data ->> 'n')::integer ELSE 0 END;
    v_n1 := CASE WHEN coalesce(v_row.data ->> 'n1', '') ~ '^[0-9]+$' THEN (v_row.data ->> 'n1')::integer ELSE 0 END;
    v_n2 := CASE WHEN coalesce(v_row.data ->> 'n2', '') ~ '^[0-9]+$' THEN (v_row.data ->> 'n2')::integer ELSE 0 END;

    WHILE v_year < v_target_year LOOP
      v_n2 := v_n1;
      v_n1 := v_n;
      v_n := 12;
      v_year := v_year + 1;
    END LOOP;

    UPDATE public.leave_balances
       SET data = v_row.data || jsonb_build_object(
         'tahun', v_year,
         'n', v_n,
         'n1', v_n1,
         'n2', v_n2
       ),
       updated_at = clock_timestamp()
     WHERE nip = v_row.nip;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.rollover_leave_balances() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rollover_leave_balances() TO authenticated;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
SELECT cron.unschedule(jobid)
  FROM cron.job
 WHERE jobname = 'annual-leave-balance-rollover';
SELECT cron.schedule(
  'annual-leave-balance-rollover',
  '0 0 1 1 *',
  'SELECT public.rollover_leave_balances();'
);
