import type { Metadata } from 'next'
import { ClerkProvider } from '@clerk/nextjs'
import { dark } from '@clerk/themes'
import { Geist, Geist_Mono } from 'next/font/google'

import { Nav } from '@/components/Nav'
import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: {
    default: 'START Video Library',
    template: '%s · START Video Library',
  },
  description: 'Stream the START LANDS video library.',
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
          colorPrimary: '#af28ea',
          colorBackground: '#140d1c',
          colorForeground: '#f4eff8',
          colorMutedForeground: '#bfb0cd',
          colorInput: '#1c1327',
          colorInputForeground: '#f4eff8',
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
          <main className="flex-1">{children}</main>
        </body>
      </html>
    </ClerkProvider>
  )
}
