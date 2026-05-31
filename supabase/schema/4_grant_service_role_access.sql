-- Allow the service_role to read and write thoughts
grant select, insert, update, delete on table public.thoughts to service_role;