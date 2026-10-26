-- Public app_settings reads evaluate this predicate even for public keys.
-- Anonymous callers have no linked NIP, so is_admin() can only return false.
GRANT EXECUTE ON FUNCTION public.is_admin(integer) TO anon;
