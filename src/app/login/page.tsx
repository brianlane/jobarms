import { Suspense } from "react";
import { AuthForm } from "@/components/AuthForm";

export const metadata = { title: "Log in" };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[--color-ink-950] px-6">
      <Suspense>
        <AuthForm mode="login" />
      </Suspense>
    </main>
  );
}
