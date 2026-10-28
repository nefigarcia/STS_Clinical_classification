import type { Metadata } from "next";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "STS Complication Review",
  description: "AI-assisted STS CHSD postoperative complication abstraction with clinical review",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-slate-50 text-foreground">
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
