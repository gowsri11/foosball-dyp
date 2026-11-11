// Public client config. The publishable (anon) key is designed to be exposed;
// row level security in supabase/migrations decides what it can do.
export function GET() {
  return Response.json(
    {
      supabaseUrl: process.env.SUPABASE_URL || null,
      supabaseKey:
        process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || null
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
