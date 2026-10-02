import AccountPage from "./account-page";

export default async function AccountRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AccountPage accountParam={id} />;
}
