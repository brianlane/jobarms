import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-grotesk" });
const jbmono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jbmono" });

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL?.startsWith("https")
  ? process.env.NEXT_PUBLIC_APP_URL
  : "https://jobarms.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "JobArms | Your AI applies. You interview.",
    template: "%s | JobArms"
  },
  description:
    "JobArms builds one profile from your resume, then its AI arms open real job applications in a real browser, answer every question the way you would, and submit with your approval.",
  keywords: [
    "AI job application",
    "auto apply to jobs",
    "job application bot",
    "resume tailoring AI",
    "job search automation"
  ],
  alternates: { canonical: "./" },
  openGraph: {
    type: "website",
    siteName: "JobArms",
    title: "JobArms | Your AI applies. You interview.",
    description:
      "One profile. Autonomous applications. AI arms fill out and submit job applications for you, with your approval on every answer.",
    url: SITE_URL
  },
  twitter: {
    card: "summary_large_image",
    title: "JobArms | Your AI applies. You interview.",
    description:
      "One profile. Autonomous applications. AI arms fill out and submit job applications for you, with your approval on every answer."
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${grotesk.variable} ${jbmono.variable}`}>
      <body>
        {children}
        <SpeedInsights />
      </body>
    </html>
  );
}
