import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { IBM_Plex_Mono, Inter, Inter_Tight } from 'next/font/google';
import { MinWidthGuard } from '@/components/layout/min-width-guard';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { resolveMetadataBase } from '@/lib/metadata-base';
import {
  DARK_CLASS,
  THEME_COOKIE,
  THEME_INIT_SCRIPT,
  parseThemePreference,
} from '@/lib/theme';
import './globals.css';

/* Three type roles, per the Grid design system.
 *
 *   Body     Inter          running text and UI. A neutral grotesk is the correct choice
 *                           here rather than a compromise: Swiss design uses the most
 *                           ordinary face deliberately and lets the grid carry the voice.
 *   Display  Inter Tight    headings and big numerals. Same family character, noticeably
 *                           tighter and more assertive at size, which is what gives the
 *                           app hierarchy it did not have when headings shared the body face.
 *   Data     IBM Plex Mono  uppercase micro-labels, table figures, KQL. Chosen over
 *                           JetBrains Mono because Grid leans hard on small uppercase mono
 *                           labels and Plex holds its shape better at 11px.
 *
 * All three are self-hosted at build time by next/font, so a RuleBeat install inside a
 * customer network that blocks outside traffic still renders correctly. */
const body = Inter({ variable: '--font-body', subsets: ['latin'], display: 'swap' });
const display = Inter_Tight({
  variable: '--font-display',
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  display: 'swap',
});
const data = IBM_Plex_Mono({
  variable: '--font-data',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
});

/* A self-hosted install has no fixed domain, so the base every relative image in the metadata is
 * resolved against has to be worked out per request. See lib/metadata-base.ts for how, and why
 * this is not simply a constant. The root layout is already dynamic (it reads the theme cookie
 * below), so the request-scoped read costs nothing extra. */
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'RuleBeat',
    description:
      'RuleBeat runs the governance checks your team writes for Azure on a schedule, tracks every finding over time, and never holds write access.',
    metadataBase: await resolveMetadataBase(),
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const preference = parseThemePreference((await cookies()).get(THEME_COOKIE)?.value);

  /* For an explicit choice the server can stamp the class itself, so the correct ground is
     in the very first byte of HTML. For `system` the server has no way to know the machine's
     setting, so the inline script below resolves it before paint instead. */
  const serverClass = preference === 'dark' ? DARK_CLASS : '';

  return (
    <html
      lang="en"
      className={`${body.variable} ${display.variable} ${data.variable} ${serverClass} h-full`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full antialiased" suppressHydrationWarning>
        <ThemeProvider initialPreference={preference}>{children}</ThemeProvider>
        <MinWidthGuard />
      </body>
    </html>
  );
}
