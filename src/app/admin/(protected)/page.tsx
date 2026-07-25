import { redirect } from "next/navigation";

/** /admin is the console's front door; the overview lives at /admin/dashboard. */
export default function AdminIndexPage() {
  redirect("/admin/dashboard");
}
