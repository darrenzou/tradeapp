import { checkPlaidConnection } from "@/lib/plaid";
import { checkSupabaseConnection } from "@/lib/supabase";
import { checkSnapTradeConnection } from "@/lib/snaptrade";

export async function GET() {
  try {
    const [supabase, plaid, snaptrade] = await Promise.all([
      checkSupabaseConnection(),
      checkPlaidConnection(),
      checkSnapTradeConnection(),
    ]);
    const connected = supabase.connected && plaid.connected && snaptrade.connected;

    return Response.json(
      { connected, services: { supabase, plaid, snaptrade } },
      { status: connected ? 200 : 503 },
    );
  } catch (error) {
    return Response.json(
      {
        connected: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 503 },
    );
  }
}
