import type { Metadata } from 'next'
import { ClerkProvider } from '@clerk/nextjs'
import { dark } from '@clerk/themes'
import { Geist, Geist_Mono } from 'next/font/google'

import { BottomNav } from '@/components/BottomNav'
import { Nav } from '@/components/Nav'
import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: {
    default: 'START Reels',
    template: '%s · START Reels',
  },
  description: 'Bingeable vertical short dramas and mini-series from START LANDS.',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // Clerk's own UI is themed to match the app rather than left on its
    // default light card, which would flash white against a dark page on
    // every sign-in.
    <ClerkProvider
      appearance={{
        // Clerk v7 renamed `baseTheme` -> `theme` on Appearance.
        theme: dark,
        // Clerk v7 renamed these: colorText -> colorForeground,
        // colorTextSecondary -> colorMutedForeground, colorInputBackground ->
        // colorInput. The old names typecheck as excess properties and are
        // silently ignored at runtime, so a wrong name looks like "the theme
        // didn't apply" rather than an error.
        variables: {
          colorPrimary: '#ff2d6f',
          colorBackground: '#131317',
          colorForeground: '#f5f4f6',
          colorMutedForeground: '#b9b7c0',
          colorInput: '#1a1a20',
          colorInputForeground: '#f5f4f6',
          borderRadius: '0.6rem',
        },
      }}
    >
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col bg-background text-ink">
          <Nav />
          {/* pb clears the fixed bottom tab bar; BottomNav hides itself on
              routes that don't show it, where the padding is harmless. */}
          <main className="flex-1 pb-14">{children}</main>
          <BottomNav />
        </body>
      </html>
    </ClerkProvider>
  )
}
