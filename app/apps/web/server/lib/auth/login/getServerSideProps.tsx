import process from "node:process";
import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { getDibslistLoginUrl } from "@calcom/features/auth/lib/dibslistSession";
import { WEBAPP_URL, WEBSITE_URL } from "@calcom/lib/constants";
import { getSafeRedirectUrl } from "@calcom/lib/getSafeRedirectUrl";
import { jwtVerify } from "jose";
import type { GetServerSidePropsContext } from "next";

export async function getServerSideProps(context: GetServerSidePropsContext) {
  const { req, query } = context;

  const session = await getServerSession({ req });

  const verifyJwt = (jwt: string) => {
    const secret = new TextEncoder().encode(process.env.CALENDSO_ENCRYPTION_KEY);

    return jwtVerify(jwt, secret, {
      issuer: WEBSITE_URL,
      audience: `${WEBSITE_URL}/auth/login`,
      algorithms: ["HS256"],
    });
  };

  let totpEmail = null;
  if (context.query.totp) {
    try {
      const decryptedJwt = await verifyJwt(context.query.totp as string);
      if (decryptedJwt.payload) {
        totpEmail = decryptedJwt.payload.email as string;
      } else {
        return {
          redirect: {
            destination: "/auth/error?error=JWT%20Invalid%20Payload",
            permanent: false,
          },
        };
      }
    } catch {
      return {
        redirect: {
          destination: "/auth/error?error=Invalid%20JWT%3A%20Please%20try%20again",
          permanent: false,
        },
      };
    }
  }

  if (session) {
    const { callbackUrl } = query;

    if (callbackUrl) {
      try {
        const destination = getSafeRedirectUrl(callbackUrl as string);
        if (destination) {
          return {
            redirect: {
              destination,
              permanent: false,
            },
          };
        }
      } catch (e) {
        console.warn(e);
      }
    }

    return {
      redirect: {
        destination: "/",
        permanent: false,
      },
    };
  }

  // CV-1 — cal's own login/signup are DISABLED. Authentication is delegated to
  // the dibslist main app (Better Auth / Google). An unauthenticated visitor is
  // bounced to the dibslist login with a `?next=` pointing back at the booking
  // app so they return here after signing in. The dibslist Better-Auth cookie is
  // set on `Domain=.dibslist.app`, so it arrives at book.dibslist.app and
  // `getServerSession` then validates it.
  const callbackUrl = typeof query.callbackUrl === "string" ? query.callbackUrl : undefined;
  let nextUrl = `${WEBAPP_URL}/`;
  if (callbackUrl) {
    try {
      const safe = getSafeRedirectUrl(callbackUrl);
      if (safe) nextUrl = safe.startsWith("http") ? safe : `${WEBAPP_URL}${safe}`;
    } catch {
      // ignore — fall back to the app root
    }
  }
  return {
    redirect: {
      destination: getDibslistLoginUrl(nextUrl),
      permanent: false,
    },
  };
}
