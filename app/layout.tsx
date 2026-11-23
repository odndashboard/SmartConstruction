import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "smart construction · Your projects, connected",
  description: "The private workspace for leads, follow-ups, GST quotations and construction work orders.",
  robots: { index: false, follow: false },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
