-- Who ever signed in. Identity comes from Google, so there is no password to store.
create table if not exists accounts (
  id          text primary key,
  google_sub  text unique not null,
  email       text not null,
  name        text,
  created_at  timestamptz not null default now()
);

-- Browser sessions. Only a hash of the token is kept: if this table ever leaks, the rows in it
-- cannot be replayed as logins.
create table if not exists sessions (
  token_hash  text primary key,
  account_id  text not null references accounts(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index if not exists sessions_account_idx on sessions (account_id);
create index if not exists sessions_expiry_idx on sessions (expires_at);

-- What an account may do. A room is Pro while the musician running it is entitled, so this is the
-- only place a paid plan lives; rooms themselves stay throwaway and in memory.
create table if not exists entitlements (
  account_id      text primary key references accounts(id) on delete cascade,
  -- Free trial of the full band, granted once per account on first sign-in
  trial_ends_at   timestamptz,
  -- Paid through this instant. Null until the first payment clears.
  paid_until      timestamptz,
  -- The subscription at the payment provider, so its webhooks can find this row
  provider        text,
  provider_ref    text,
  updated_at      timestamptz not null default now()
);

create unique index if not exists entitlements_provider_ref_idx
  on entitlements (provider, provider_ref)
  where provider_ref is not null;
