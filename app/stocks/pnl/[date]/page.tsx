import DayPage from "./day-page";

export default async function DayRoute({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  return <DayPage date={date} />;
}
