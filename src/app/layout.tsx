import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "https://jobarms.com"),
  title: {
    default: "JobArms — your AI applies, you interview",
    template: "%s · JobArms"
  },
  description:
    "One profile. Autonomous applications. JobArms' AI arms fill out and submit job applications for you — you review, approve, and interview."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
