import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware({
  frontendApiProxy: {
    enabled: true,
  },
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ico|mid|midi|woff2?)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
