import { Suspense } from "react";
import { NewApplicationForm } from "@/components/NewApplicationForm";

export const metadata = { title: "Apply to a job" };

export default function NewApplicationPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold text-slate-900">Apply to a job</h1>
      <p className="mb-8 text-slate-500">Paste a job link and send an arm after it.</p>
      <Suspense>
        <NewApplicationForm />
      </Suspense>
    </div>
  );
}
