import HoldingPage from "./holding-page";

export default async function HoldingRoute({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  return <HoldingPage holdingKey={symbol} />;
}
