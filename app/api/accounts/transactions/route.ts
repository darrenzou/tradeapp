import { NextResponse, type NextRequest } from "next/server";

import { AccountNotFoundError, loadAccountTransactions } from "@/lib/account-transactions";
import { errorResponse, requireSessionUser } from "@/lib/session";

// GET ?account=<LinkedAccount id>&offset=<n>: one page of an account's
// transactions, newest first. With &all=1, every transaction at once, for
// the account's page and its search.
export async function GET(request: NextRequest) {
  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  const params = request.nextUrl.searchParams;
  const accountId = params.get("account") ?? "";
  const offset = Number(params.get("offset") ?? "0");

  if (!Number.isInteger(offset) || offset < 0) {
    return errorResponse("That page isn't available.", 400);
  }

  try {
    const data = await loadAccountTransactions(
      user.id,
      accountId,
      offset,
      {},
      params.get("all") === "1" ? Number.MAX_SAFE_INTEGER : undefined,
    );
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof AccountNotFoundError) {
      return errorResponse("That account isn't connected anymore.", 404);
    }

    return errorResponse("Transactions couldn't be loaded. Try again.", 503);
  }
}
