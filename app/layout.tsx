export const metadata = {
  title: "Agentic Video Generator",
  description: "Generate videos from prompts with Veo3 and Sora2 styles"
};

import "./globals.css";
import { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}

