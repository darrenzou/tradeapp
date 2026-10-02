import { combinedCsv, parseStatementLines, pdfLines, type BankFileRows, type PdfTextItem } from "@/lib/bank-statement";
import { guessInstitution, parseBankCsv } from "@/lib/imported-transactions";

// What the chosen files hold, read in the browser before anything is sent.
export type BankFiles = {
  // One CSV of every file's transactions, which the import reads.
  csv: string;
  label: string;
  files: number;
  count: number;
  earliest: string;
  latest: string;
  moneyIn: number;
  moneyOut: number;
  mask: string | null;
  hasBalance: boolean;
  institution: string | null;
  // A card statement's account is a credit card.
  kind: "cash" | "credit" | null;
};

type ReadFile = BankFileRows & { institution: string | null; card: boolean };

export const BANK_FILE_TYPES = ".csv,.pdf,text/csv,application/pdf";

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

// A statement PDF's text, line by line. pdf.js is loaded only when a PDF is
// picked.
async function readPdf(file: File): Promise<{ lines: string[] } | { error: string }> {
  const { getDocumentProxy } = await import("unpdf");
  let document: Awaited<ReturnType<typeof getDocumentProxy>>;

  try {
    document = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    return {
      error:
        error instanceof Error && error.name === "PasswordException"
          ? `${file.name} is password protected.`
          : `${file.name} couldn't be opened.`,
    };
  }

  const lines: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];

      for (const item of content.items) {
        if ("str" in item) {
          items.push({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height });
        }
      }

      lines.push(...pdfLines(items));
    }
  } finally {
    void document.cleanup();
  }

  return { lines };
}

async function readFile(file: File): Promise<ReadFile | { error: string }> {
  if (isPdf(file)) {
    const pdf = await readPdf(file);

    if ("error" in pdf) {
      return pdf;
    }

    const parsed = parseStatementLines(pdf.lines);

    if ("error" in parsed) {
      return { error: parsed.error.replace("that PDF", file.name).replace("That PDF", file.name) };
    }

    return { ...parsed, institution: guessInstitution(pdf.lines.slice(0, 40).join(" ")) };
  }

  let text: string;

  try {
    text = await file.text();
  } catch {
    return { error: `${file.name} couldn't be read.` };
  }

  const parsed = parseBankCsv(text, "preview");

  if ("error" in parsed) {
    return { error: parsed.error.replace("That file", file.name) };
  }

  return {
    rows: parsed.transactions.map(({ date, description, amount }) => ({ date, description, amount })),
    mask: parsed.mask,
    balance: parsed.balance,
    institution: null,
    card: false,
  };
}

// Reads the chosen CSV downloads and statement PDFs into one import.
export async function readBankFiles(files: File[]): Promise<BankFiles | { error: string }> {
  if (files.length === 0) {
    return { error: "Choose a file." };
  }

  const read: ReadFile[] = [];

  for (const file of files) {
    const result = await readFile(file).catch(() => ({ error: `${file.name} couldn't be read.` }));

    if ("error" in result) {
      return result;
    }

    read.push(result);
  }

  const masks = [...new Set(read.map((file) => file.mask).filter((mask) => mask !== null))];

  if (masks.length > 1) {
    const accounts = masks.map((mask) => `••${mask}`).join(" and ");
    return { error: `These files are from different accounts (${accounts}). Import one account at a time.` };
  }

  const csv = combinedCsv(read);
  const parsed = parseBankCsv(csv, "preview");

  if ("error" in parsed) {
    return parsed;
  }

  const dates = parsed.transactions.map((transaction) => transaction.date).sort();
  const sum = (moneyIn: boolean) =>
    parsed.transactions.reduce((total, { amount }) => total + (moneyIn === amount < 0 ? Math.abs(amount) : 0), 0);

  return {
    csv,
    label: files.length === 1 ? files[0].name : `${files.length} files`,
    files: files.length,
    count: parsed.transactions.length,
    earliest: dates[0],
    latest: dates[dates.length - 1],
    moneyIn: sum(true),
    moneyOut: sum(false),
    mask: parsed.mask,
    hasBalance: parsed.balance !== null,
    institution:
      files.map((file) => guessInstitution(file.name)).find((name) => name !== null) ??
      read.map((file) => file.institution).find((name) => name !== null) ??
      null,
    kind: read.some((file) => file.card) ? "credit" : null,
  };
}
