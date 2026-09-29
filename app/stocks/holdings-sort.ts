// Sorting for the Stocks page's holdings table. Clicking a column heading
// cycles through the default order (largest holding first), highest to
// lowest, and lowest to highest. Text columns go A to Z first instead, and
// dates go most recent first.

export type SortDirection = "descending" | "ascending";

export type SortState = { column: string; direction: SortDirection } | null;

export type SortValue = number | string | null;

// The state after clicking a column's heading: the first click on a column
// sorts it in its first direction, the second reverses it, and the third
// returns to the default order.
export function nextSort(current: SortState, column: string, firstDirection: SortDirection): SortState {
  if (current === null || current.column !== column) {
    return { column, direction: firstDirection };
  }

  return current.direction === firstDirection
    ? { column, direction: firstDirection === "descending" ? "ascending" : "descending" }
    : null;
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }

  return String(a).localeCompare(String(b), "en-US", { numeric: true, sensitivity: "base" });
}

// Rows without a value (shown as "—") stay at the bottom either way, and
// ties keep their default order.
export function sortRows<Row>(rows: Row[], direction: SortDirection, valueOf: (row: Row) => SortValue): Row[] {
  const sign = direction === "descending" ? -1 : 1;

  return rows
    .map((row, index) => ({ row, index, value: valueOf(row) }))
    .sort((a, b) => {
      const aMissing = a.value === null || (typeof a.value === "number" && Number.isNaN(a.value));
      const bMissing = b.value === null || (typeof b.value === "number" && Number.isNaN(b.value));

      if (aMissing || bMissing) {
        return aMissing === bMissing ? a.index - b.index : aMissing ? 1 : -1;
      }

      return sign * compareValues(a.value!, b.value!) || a.index - b.index;
    })
    .map((entry) => entry.row);
}
