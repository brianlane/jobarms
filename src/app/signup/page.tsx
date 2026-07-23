import { Suspense } from "react";
import { AuthForm } from "@/components/AuthForm";

export const metadata = { title: "Sign up" };

export default function SignupPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[--color-ink-950] px-6">
      <Suspense>
        <AuthForm mode="signup" />
      </Suspense>
    </main>
  );
}
