import type { ReactNode } from "react";

import { APP_NAME } from "@calcom/lib/constants";

/**
 * Branded "Create your account" landing shown at the booking app root for
 * UNAUTHENTICATED visitors. Mirrors cal's signup aesthetic but every CTA is a
 * plain anchor to the dibslist Better-Auth login (`loginUrl`) — cal's own
 * native auth is disabled (CV-1), so there is one unified dibslist account.
 *
 * Pure server component: no hooks, no client JS, no NextAuth. The dibslist
 * login page itself presents the provider choice (Google / email) and returns
 * the visitor here authenticated via the `.dibslist.app` cookie.
 */
export function BookingAuthLanding({ loginUrl }: { loginUrl: string }) {
  return (
    <div className="light flex min-h-screen w-full flex-col items-center justify-center bg-cal-muted 2xl:bg-default">
      <div className="grid w-full max-w-[1440px] grid-cols-1 grid-rows-1 overflow-hidden bg-cal-muted lg:grid-cols-2 2xl:rounded-[20px] 2xl:border 2xl:border-subtle 2xl:py-6">
        {/* Left — auth CTA */}
        <div className="flex items-center justify-center p-8 lg:p-16">
          <div className="w-full max-w-[420px]">
            <h1 className="font-bold text-2xl text-emphasis leading-8 lg:text-[28px]">
              Create your {APP_NAME} account
            </h1>
            <p className="mt-2 font-medium text-base text-subtle leading-5">
              Free for individuals. Book meetings, share your availability, and sync your calendars.
            </p>

            <a
              href={loginUrl}
              data-testid="continue-with-google-button"
              className="mt-8 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#111827] px-4 font-medium text-sm text-white transition hover:opacity-90">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/google-icon-colored.svg" alt="" className="h-4 w-4 brightness-0 invert" />
              Continue with Google
            </a>

            <div className="my-5 flex items-center gap-3">
              <span className="h-px flex-1 bg-subtle" />
              <span className="text-subtle text-sm">or</span>
              <span className="h-px flex-1 bg-subtle" />
            </div>

            <a
              href={loginUrl}
              className="flex h-11 w-full items-center justify-center rounded-lg border border-subtle bg-default px-4 font-medium text-emphasis text-sm transition hover:bg-muted">
              Continue with email
            </a>

            <p className="mt-8 text-subtle text-sm">
              Already have an account?{" "}
              <a href={loginUrl} className="font-medium text-emphasis hover:underline">
                Sign in
              </a>
            </p>
          </div>
        </div>

        {/* Right — feature panel */}
        <div className="hidden flex-col justify-center gap-8 bg-default p-16 lg:flex">
          <Feature
            title="Connect all your calendars"
            body={`${APP_NAME} reads availability from all your existing calendars.`}
            icon={
              <path d="M8 2v3M16 2v3M3.5 9.09h17M21 8.5V17c0 3-1.5 5-5 5H8c-3.5 0-5-2-5-5V8.5c0-3 1.5-5 5-5h8c3.5 0 5 2 5 5Z" />
            }
          />
          <Feature
            title="Set your availability"
            body="Set schedules for the times you want to be booked."
            icon={<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>}
          />
          <Feature
            title="Share a link or embed"
            body="Share your booking link or embed it on your site."
            icon={
              <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19" />
            }
          />
        </div>
      </div>

      <div className="mt-6 text-center text-subtle text-xs">{APP_NAME}</div>
    </div>
  );
}

function Feature({ title, body, icon }: { title: string; body: string; icon: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 h-5 w-5 shrink-0 text-emphasis">
        {icon}
      </svg>
      <div>
        <p className="font-semibold text-emphasis text-sm">{title}</p>
        <p className="mt-0.5 text-subtle text-sm leading-5">{body}</p>
      </div>
    </div>
  );
}

export default BookingAuthLanding;
