import { redirect } from "next/navigation";

// `/` is the owner's public booking page: proxy.ts rewrites it to
// /<OWNER_USERNAME> before routing gets here (see @calcom/lib/ownerRouting). This
// page is only reached when OWNER_USERNAME is unset, in which case there is
// nothing public to show, so send the owner to the dashboard.
const RootPage = () => redirect("/dash");

export default RootPage;
