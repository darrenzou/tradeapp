import MonthPage from "./month-page";

export default async function SpendingMonthRoute({ params }: { params: Promise<{ month: string }> }) {
  const { month } = await params;
  return <MonthPage month={month} />;
}
