import { AccountType } from "plaid";
import { NextResponse, type NextRequest } from "next/server";

import { AccountNotFoundError, findPlaidAccount, type PlaidAccountMatch } from "@/lib/account-transactions";
import { parseBankCsv } from "@/lib/imported-transactions";
import { replaceImportedTransactions } from "@/lib/imported-transactions-store";
import { isJsonContentType, isSameOrigin } from "@/lib/request";
import { errorResponse, requireSessionUser, type SessionUser } from "@/lib/session";

// A bank's CSV download of a couple of years is well under this.
const MAX_CSV_CHARACTERS = 2_000_000;
const PLAID_ACCOUNT_ID = /^plaid:([A-Za-z0-9_-]+)$/;

type Checked = { user: SessionUser; body: Record<string, unknown>; match: PlaidAccountMatch };

// The signed-in user, the JSON body, and the bank or card account it names.
async function check(request: NextRequest): Promise<Checked | NextResponse> {
  if (!isSameOrigin(request)) {
    return errorResponse("Request not allowed.", 403);
  }

  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  let body: unknown = null;

  if (isJsonContentType(request)) {
    try {
      body = await request.json();
    } catch {
      body = null;
    }
  }

  if (typeof body !== "object" || body === null) {
    return errorResponse("That request isn't valid.", 400);
  }

  const record = body as Record<string, unknown>;
  const match = PLAID_ACCOUNT_ID.exec(typeof record.account === "string" ? record.account : "");

  if (match === null) {
    return errorResponse("Transactions can only be imported into a bank or card account.", 400);
  }

  try {
    const found = await findPlaidAccount(user.id, match[1]);

    if (found.account.type === AccountType.Investment || found.account.type === AccountType.Brokerage) {
      return errorResponse("Transactions can only be imported into a bank or card account.", 400);
    }

    return { user, body: record, match: found };
  } catch (error) {
    return error instanceof AccountNotFoundError
      ? errorResponse("That account isn't connected anymore.", 404)
      : errorResponse("Your accounts couldn't be loaded. Try again.", 503);
  }
}

// POST {account, csv}: imports a CSV downloaded from the bank into the
// account, replacing any earlier import. Rows Plaid already has are left out
// when the account's transactions are listed.
export async function POST(request: NextRequest) {
  const checked = await check(request);

  if (checked instanceof NextResponse) {
    return checked;
  }

  const { user, body, match } = checked;
  const csv = body.csv;

  if (typeof csv !== "string" || csv.length > MAX_CSV_CHARACTERS) {
    return errorResponse("That file is too big to import.", 400);
  }

  const parsed = parseBankCsv(csv, match.settingsKey);

  if ("error" in parsed) {
    return errorResponse(parsed.error, 400);
  }

  try {
    await replaceImportedTransactions(user.id, match.settingsKey, parsed.transactions);
  } catch {
    return errorResponse("The file couldn't be saved. Try again.", 503);
  }

  const dates = parsed.transactions.map((transaction) => transaction.date).sort();

  return NextResponse.json(
    {
      imported: parsed.transactions.length,
      skipped: parsed.skipped,
      earliest: dates[0],
      latest: dates[dates.length - 1],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// DELETE {account}: removes the account's imported transactions.
export async function DELETE(request: NextRequest) {
  const checked = await check(request);

  if (checked instanceof NextResponse) {
    return checked;
  }

  try {
    await replaceImportedTransactions(checked.user.id, checked.match.settingsKey, []);
  } catch {
    return errorResponse("The imported transactions couldn't be removed. Try again.", 503);
  }

  return NextResponse.json({ imported: 0 }, { headers: { "Cache-Control": "no-store" } });
}
