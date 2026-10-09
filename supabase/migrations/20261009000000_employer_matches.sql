-- Each user's 401(k) employer matches, set on the Stocks page's 401k
-- contributions sheet: { "<account id>": { "salary": 87550, "percent": 5 } }.
-- See EmployerMatch in lib/retirement-contributions.ts. Null until set.

alter table public.user_settings add column if not exists employer_matches jsonb;
