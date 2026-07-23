import { OnboardingWizard } from "@/components/OnboardingWizard";

export const metadata = { title: "Onboarding" };

export default function OnboardingPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-16">
      <OnboardingWizard />
    </main>
  );
}
