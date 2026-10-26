-- Keep the trusted Admin 1/2 login emails aligned with their verified accounts.
UPDATE public.staff_members
   SET email = CASE sort
     WHEN 1 THEN 'hermansyahppuji@gmail.com'
     WHEN 2 THEN 'hartonodisnavtgpriok@gmail.com'
   END
 WHERE role = 'admin'
   AND sort IN (1, 2);
