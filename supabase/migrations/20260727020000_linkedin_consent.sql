-- Records that a user has connected their own LinkedIn account and consented to
-- the arm applying on their behalf with it.
--
-- Why a consent timestamp and not just the vault row: LinkedIn is the first ATS
-- where the credentials are the user's real professional identity, not an
-- account the arm creates and owns. LinkedIn actively restricts accounts caught
-- automating Easy Apply, so we record explicit, timestamped consent before any
-- run touches the account, and clear it the moment they disconnect.
--
-- The credentials themselves live in `site_accounts` (service-role only,
-- deny-all RLS, AES-256-GCM encrypted password) exactly like the Workday
-- tenant accounts. Only this consent marker lives on the read-own profile row.
alter table public.profiles
  add column if not exists linkedin_consent_at timestamptz;
