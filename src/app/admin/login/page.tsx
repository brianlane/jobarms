import { Suspense } from "react";
import { redirect } from "next/navigation";
import { adminConfigured, getAdminUser } from "@/lib/admin/guard";
import { getAuthUser } from "@/lib/supabase/auth";
import { AdminLoginForm } from "@/components/admin/AdminLoginForm";
import { safeNextPath } from "@/lib/redirect";

export const metadata = { title: "Admin sign in", robots: { index: false, follow: false } };

export default async function AdminLoginPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target = safeNextPath(next, "/admin/dashboard");

  const admin = await getAdminUser();
  if (admin) redirect(target);

  // Signed in but not on the allowlist: the form clears that session on mount
  // so the operator is not left staring at a form that silently cannot work.
  const signedIn = Boolean(await getAuthUser());

  return (
    <main className="hero-glow flex min-h-screen flex-col items-center justify-center bg-ink-950 px-6 py-12">
      <Suspense>
        <AdminLoginForm forceSignOut={signedIn} adminConfigured={adminConfigured()} />
      </Suspense>
    </main>
  );
}
