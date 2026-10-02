import { Suspense } from "react";

import TargetsPage from "./targets-page";

export default function TargetsRoute() {
  // The page reads ?from= to know where Back goes.
  return (
    <Suspense>
      <TargetsPage />
    </Suspense>
  );
}
