import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware({
  frontendApiProxy: {
    enabled: () =>
      process.env.VERCEL_TARGET_ENV === "production" &&
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith("pk_live_") === true,
  },
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ico|mid|midi|woff2?)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
