// Test-only placeholders. Never use production credentials here.
process.env.NEXT_PUBLIC_SUPABASE_URL ??=
  "https://example.supabase.co";

process.env.SUPABASE_SERVICE_ROLE_KEY ??=
  "test-only-service-role-key";

process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??=
  "test-only-publishable-key";

process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??=
  "test-only-anon-key";