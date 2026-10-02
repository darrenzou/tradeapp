import { AccountType } from "plaid";
import { NextResponse, type NextRequest } from "next/server";

import { AccountNotFoundError, findPlaidAccount } from "@/lib/account-transactions";
import { parseBankCsv, type ImportedTransaction } from "@/lib/imported-transactions";
import {
  createImportedAccount,
  deleteImportedAccount,
  findImportedAccount,
  replaceImportedTransactions,
  updateImportedBalance,
} from "@/lib/imported-transactions-store";
import { MAX_NICKNAME_LENGTH } from "@/lib/overview-settings";
import { isJsonContentType, isSameOrigin } from "@/lib/request";
import { errorResponse, requireSessionUser, type SessionUser } from "@/lib/session";

// A bank's CSV download of a couple of years is well under this.
const MAX_CSV_CHARACTERS = 2_000_000;
const PLAID_ACCOUNT_ID = /^plaid:([A-Za-z0-9_-]+)$/;
const NOT_A_BANK = "Transactions can only be imported into a bank or card account.";

// Where the transactions go: a linked Plaid account (stored under its
// settings key) or an account added from a bank file.
type Target = { key: string; importedAccountId: string | null };

type Checked = { user: SessionUser; body: Record<string, unknown> };

// The signed-in user and the JSON body.
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

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse("That request isn't valid.", 400);
  }

  return { user, body: body as Record<string, unknown> };
}

// The bank or card account the body names.
async function findTarget(userId: string, account: unknown): Promise<Target | NextResponse> {
  const id = typeof account === "string" ? account : "";
  const plaid = PLAID_ACCOUNT_ID.exec(id);

  try {
    if (plaid !== null) {
      const found = await findPlaidAccount(userId, plaid[1]);

      if (found.account.type === AccountType.Investment || found.account.type === AccountType.Brokerage) {
        return errorResponse(NOT_A_BANK, 400);
      }

      return { key: found.settingsKey, importedAccountId: null };
    }

    if ((await findImportedAccount(userId, id)) !== null) {
      return { key: id, importedAccountId: id };
    }

    return errorResponse(NOT_A_BANK, 400);
  } catch (error) {
    return error instanceof AccountNotFoundError
      ? errorResponse("That account isn't connected anymore.", 404)
      : errorResponse("Your accounts couldn't be loaded. Try again.", 503);
  }
}

type NewAccount = { institution: string; name: string; mask: string | null; kind: "cash" | "credit" };

// The details typed for an account that isn't linked, or an error message.
function readNewAccount(value: unknown, maskInFile: string | null): NewAccount | string {
  if (typeof value !== "object" || value === null) {
    return "That request isn't valid.";
  }

  const record = value as Record<string, unknown>;
  const institution = typeof record.institution === "string" ? record.institution.trim() : "";
  const nickname = typeof record.nickname === "string" ? record.nickname.trim() : "";
  const typedMask = typeof record.mask === "string" ? record.mask.trim() : "";
  const kind = record.kind === "credit" ? "credit" : "cash";

  if (institution === "" || institution.length > MAX_NICKNAME_LENGTH) {
    return "Enter the bank's name.";
  }

  if (nickname.length > MAX_NICKNAME_LENGTH) {
    return `Keep the nickname under ${MAX_NICKNAME_LENGTH} characters.`;
  }

  if (typedMask !== "" && !/^\d{4}$/.test(typedMask)) {
    return "Enter the account's last 4 digits.";
  }

  const mask = maskInFile ?? (typedMask || null);

  if (mask === null) {
    return "Enter the account's last 4 digits.";
  }

  return { institution, name: nickname || (kind === "credit" ? "Credit card" : "Checking"), mask, kind };
}

function summary(transactions: ImportedTransaction[], skipped: number, account: string) {
  const dates = transactions.map((transaction) => transaction.date).sort();

  return NextResponse.json(
    { account, imported: transactions.length, skipped, earliest: dates[0], latest: dates[dates.length - 1] },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// POST {account, csv}: imports a CSV downloaded from the bank into a linked
// account, replacing any earlier import. Rows Plaid already has are left out
// when the account's transactions are listed.
// POST {newAccount: {institution, nickname, mask, kind}, csv}: adds an
// account that isn't linked, with the file's transactions and balance. The
// last 4 digits can be left out when the file has them.
export async function POST(request: NextRequest) {
  const checked = await check(request);

  if (checked instanceof NextResponse) {
    return checked;
  }

  const { user, body } = checked;
  const csv = body.csv;

  if (typeof csv !== "string" || csv.length > MAX_CSV_CHARACTERS) {
    return errorResponse("That file is too big to import.", 400);
  }

  if (body.newAccount !== undefined) {
    // Read once to check the file; the rows are keyed by the new account's
    // id below, the same as a later import of a newer download.
    const parsed = parseBankCsv(csv, "new");

    if ("error" in parsed) {
      return errorResponse(parsed.error, 400);
    }

    const details = readNewAccount(body.newAccount, parsed.mask);

    if (typeof details === "string") {
      return errorResponse(details, 400);
    }

    let accountId: string | null = null;

    try {
      const latest = parsed.transactions.reduce((newest, { date }) => (date > newest ? date : newest), "");
      accountId = await createImportedAccount(
        user.id,
        { ...details, balance: parsed.balance === null ? null : Math.abs(parsed.balance) },
        latest,
      );
      const keyed = parseBankCsv(csv, accountId);
      await replaceImportedTransactions(user.id, accountId, "error" in keyed ? [] : keyed.transactions);
    } catch {
      if (accountId !== null) {
        await deleteImportedAccount(user.id, accountId).catch(() => undefined);
      }

      return errorResponse("The file couldn't be saved. Try again.", 503);
    }

    return summary(parsed.transactions, parsed.skipped, accountId);
  }

  const target = await findTarget(user.id, body.account);

  if (target instanceof NextResponse) {
    return target;
  }

  const parsed = parseBankCsv(csv, target.key);

  if ("error" in parsed) {
    return errorResponse(parsed.error, 400);
  }

  try {
    await replaceImportedTransactions(user.id, target.key, parsed.transactions);

    if (target.importedAccountId !== null) {
      const latest = parsed.transactions.reduce((newest, { date }) => (date > newest ? date : newest), "");
      await updateImportedBalance(
        user.id,
        target.importedAccountId,
        parsed.balance === null ? null : Math.abs(parsed.balance),
        latest,
      );
    }
  } catch {
    return errorResponse("The file couldn't be saved. Try again.", 503);
  }

  return summary(parsed.transactions, parsed.skipped, String(body.account));
}

// DELETE {account}: removes a linked account's imported transactions, or an
// account added from a bank file along with its transactions.
export async function DELETE(request: NextRequest) {
  const checked = await check(request);

  if (checked instanceof NextResponse) {
    return checked;
  }

  const target = await findTarget(checked.user.id, checked.body.account);

  if (target instanceof NextResponse) {
    return target;
  }

  try {
    if (target.importedAccountId !== null) {
      await deleteImportedAccount(checked.user.id, target.importedAccountId);
    } else {
      await replaceImportedTransactions(checked.user.id, target.key, []);
    }
  } catch {
    return errorResponse("That couldn't be removed. Try again.", 503);
  }

  return NextResponse.json({ imported: 0 }, { headers: { "Cache-Control": "no-store" } });
}
