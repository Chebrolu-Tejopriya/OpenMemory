import type { Metadata } from "next";
import { Geist, Baloo_2, Baloo_Bhai_2 } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

const baloo2 = Baloo_2({
  variable: "--font-baloo-2",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const balooBhai2 = Baloo_Bhai_2({
  variable: "--font-baloo-bhai-2",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "OpenMemory - Find what inspires you",
  description: "Semantic search for your bookmarks and design inspirations",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${baloo2.variable} ${balooBhai2.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
