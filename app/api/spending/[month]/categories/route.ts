import { NextResponse, type NextRequest } from "next/server";

import { isCategoryChoice, type CategoryRuleChange } from "@/lib/cashflow";
import { saveCategoryRules } from "@/lib/category-rules";
import { isJsonContentType, isSameOrigin } from "@/lib/request";
import { errorResponse, requireSessionUser } from "@/lib/session";
import { loadSpendingMonth } from "@/lib/spending";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const RULE_KEY_PATTERN = /^(transaction|similar):./;
const MAX_KEY_LENGTH = 500;
// A transaction and its transfer counterpart, each possibly clearing a
// one-transaction choice as well.
const MAX_CHANGES = 4;

async function parseChanges(request: NextRequest): Promise<CategoryRuleChange[] | null> {
  if (!isJsonContentType(request)) {
    return null;
  }

  let value: unknown;

  try {
    value = await request.json();
  } catch {
    return null;
  }

  const changes = typeof value === "object" && value !== null ? (value as Record<string, unknown>).changes : null;

  if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_CHANGES) {
    return null;
  }

  const parsed: CategoryRuleChange[] = [];

  for (const change of changes) {
    const { key, category } = (typeof change === "object" && change !== null ? change : {}) as Record<string, unknown>;

    if (
      typeof key !== "string" ||
      key.length > MAX_KEY_LENGTH ||
      !RULE_KEY_PATTERN.test(key) ||
      !(category === null || (typeof category === "string" && isCategoryChoice(category)))
    ) {
      return null;
    }

    parsed.push({ key, category });
  }

  return parsed;
}

// Saves the categories the user picked on a month's page and returns that
// month again with them applied.
export async function POST(request: NextRequest, { params }: { params: Promise<{ month: string }> }) {
  if (!isSameOrigin(request)) {
    return errorResponse("Request not allowed.", 403);
  }

  const user = await requireSessionUser(request);

  if (user instanceof NextResponse) {
    return user;
  }

  const { month } = await params;
  const changes = await parseChanges(request);

  if (!MONTH_PATTERN.test(month) || changes === null) {
    return errorResponse("That category change isn't valid.", 400);
  }

  try {
    await saveCategoryRules(user.id, changes);
  } catch {
    return errorResponse("The category couldn't be saved. Try again.", 503);
  }

  try {
    const data = await loadSpendingMonth(user.id, month);

    if (data === null) {
      return errorResponse("That month is outside the last 3 years.", 404);
    }

    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return errorResponse("The category was saved, but the month couldn't be reloaded. Try again.", 503);
  }
}
