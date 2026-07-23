import Link from "next/link";
import { Suspense } from "react";
import { AuthForm } from "@/components/AuthForm";

export const metadata = { title: "Log in" };

export default function LoginPage() {
  return (
    <main className="hero-glow flex min-h-screen flex-col items-center justify-center bg-ink-950 px-6 py-12">
      <Link href="/" className="mb-10 font-display text-2xl font-bold text-white">
        Job<span className="text-arm-400">Arms</span>
      </Link>
      <Suspense>
        <AuthForm mode="login" />
      </Suspense>
    </main>
  );
}
