import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PwaRegister } from "@/components/pwa-register";

export const metadata: Metadata = {
  title: "Speech-AI Research Hub",
  description: "Speech-AI 研究協作空間",
  icons: { icon: "/brand-mark.svg", apple: "/brand-mark.svg" },
  openGraph: { images: ["/brand-cover.svg"] },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Speech-AI Hub", statusBarStyle: "default" },
};
export const viewport: Viewport = { themeColor: "#356b9f" };
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant" suppressHydrationWarning><head><script src="/theme-init.js" /></head><body><PwaRegister/>{children}</body></html>;
}
